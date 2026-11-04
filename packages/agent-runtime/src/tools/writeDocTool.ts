import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Static, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type ArgRecord, asRecord, compact, type Parsed, pick, trimmed } from './args';
import { DOCUMENT_EXTENSIONS, isDocumentPath } from './documentPath';
import { errorResult, safely, type ToolResult, textResult } from './result';
import { PLAN_CONTENT_MAX_BYTES } from './writePlanTool';

export const WRITE_DOC_TOOL_NAME = 'write_doc';
/** 文档的 UTF-8 字节数上限，与 write_plan 一致（256 KiB） */
const DOC_CONTENT_MAX_BYTES = PLAN_CONTENT_MAX_BYTES;

/** write_doc 成功结果的 details */
export interface WriteDocDetails {
  /** 写入的文档绝对路径 */
  path: string;
  /** true：新建；false：整份替换了已有文档 */
  created: boolean;
  /** 写入的 UTF-8 字节数 */
  bytes: number;
}

export interface WriteDocToolOptions {
  /** 计划模式是否开启；只有返回 true 时才写（读取时抛异常按未开启处理） */
  planMode: () => boolean;
}

const writeDocSchema = Type.Object(
  {
    path: Type.String({
      description:
        'Where to write the Markdown document (.md or .markdown): an absolute path or ~/… for a file outside the workspace, otherwise a path relative to the workspace.',
    }),
    content: Type.String({
      description: `The whole document as Markdown, at most ${DOC_CONTENT_MAX_BYTES / 1024} KiB as UTF-8. It replaces an existing file in full.`,
    }),
  },
  { additionalProperties: false }
);

const EXTENSION_LIST = DOCUMENT_EXTENSIONS.join(' or ');
const REPLACE_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * write_doc：计划模式下新建或整份替换一份 Markdown 文档。只注册给 `tools: 'orchestrator'` 的会话。
 *
 * 在 agent 进程里直接用 node fs 写，不经 OrchestrationHost / Main。审批类别是 `file-write`（见 approval/policy）。
 * - 计划模式未开启时拒绝；扩展名只能是 `.md` / `.markdown`（isDocumentPath）；
 * - path 可以是绝对路径、`~` / `~/…`（用户主目录）或相对会话 cwd（工作区根目录），可以在工作区之外；
 * - 目标已存在但是目录、符号链接 / junction 或其他非普通文件时拒绝；
 * - 父目录缺失时只在工作区之内逐级创建，工作区之外必须已存在（避免手误的绝对路径造出垃圾目录）；
 * - 先在目标目录独占创建临时文件写入并落盘，再 rename 原子替换；Windows 上目标被占用导致 rename 失败时
 *   退回直接覆盖目标。
 *
 * execute 永不抛异常，失败以 errorResult 返回。
 */
export function createWriteDocTool(cwd: string, options: WriteDocToolOptions): ToolDefinition {
  return defineTool({
    name: WRITE_DOC_TOOL_NAME,
    label: 'Write document',
    description:
      'Only while plan mode is on: create or replace one Markdown document (.md or .markdown) at path, with content as the whole file. ' +
      'path is absolute or ~/… for a file outside the workspace (for example on the user’s desktop), otherwise relative to the workspace. ' +
      'Read an existing document first and keep what the user did not ask to change. Never use it for code or configuration.',
    promptSnippet: 'Plan mode: create or replace a Markdown document at a path',
    parameters: writeDocSchema,
    executionMode: 'sequential',
    prepareArguments: (raw) => normalizeWriteDocArgs(raw) as Static<typeof writeDocSchema>,
    execute: (_toolCallId, params) =>
      safely(WRITE_DOC_TOOL_NAME, () => writeDoc(cwd, options, params)),
  });
}

interface DocInput {
  /** 解析后的绝对路径 */
  target: string;
  /** 要写入的内容：UTF-8、无 BOM、以换行结尾 */
  bytes: Buffer;
}

async function writeDoc(
  cwd: string,
  options: WriteDocToolOptions,
  params: unknown
): Promise<ToolResult> {
  if (!planModeOn(options)) {
    return errorResult(
      WRITE_DOC_TOOL_NAME,
      'write_doc only works while plan mode is on. Outside plan mode a document is a file like any other: dispatch a worker to write it.'
    );
  }
  const input = parseWriteDocArgs(cwd, params);
  if (!input.ok) return errorResult(WRITE_DOC_TOOL_NAME, input.error);
  const { target, bytes } = input.value;

  const info = await lstatIfExists(target);
  if (info && (info.isSymbolicLink() || !info.isFile())) {
    return errorResult(
      WRITE_DOC_TOOL_NAME,
      `${target} is not a regular file (it is a directory, symbolic link, junction or other special file), so nothing was written`
    );
  }
  const dir = path.dirname(target);
  const parent = await ensureParent(cwd, dir);
  if (!parent.ok) return errorResult(WRITE_DOC_TOOL_NAME, parent.error);

  await replaceFile(dir, target, bytes, info !== undefined);
  const details: WriteDocDetails = { path: target, created: !info, bytes: bytes.length };
  return textResult(
    `Document saved to \`${target}\` (${info ? 'replaced' : 'created'}, ${bytes.length} bytes).`,
    details
  );
}

function planModeOn(options: WriteDocToolOptions): boolean {
  try {
    return options.planMode() === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 参数归一化（prepareArguments）与语义校验（execute）

function normalizeWriteDocArgs(raw: unknown): ArgRecord {
  const args = asRecord(raw);
  return compact({
    path: trimmed(pick(args, 'path', 'file', 'file_path', 'filePath')),
    // 正文原样保留，只在 execute 里去 BOM、补结尾换行
    content: pick(args, 'content'),
  });
}

function parseWriteDocArgs(cwd: string, params: unknown): Parsed<DocInput> {
  const args = normalizeWriteDocArgs(params);
  const rawPath = args.path;
  if (typeof rawPath !== 'string' || rawPath === '' || !isDocumentPath(rawPath)) {
    return {
      ok: false,
      error: `path is required and must name a Markdown document ending in ${EXTENSION_LIST} (no ':' or <>"|?* in the file name); code, configuration and other files cannot be written in plan mode`,
    };
  }
  if (args.content === undefined) {
    return { ok: false, error: 'content is required: the whole document as Markdown' };
  }
  if (typeof args.content !== 'string') {
    return { ok: false, error: 'content must be a string of Markdown' };
  }
  let text = args.content.startsWith('\uFEFF') ? args.content.slice(1) : args.content;
  if (!text.trim()) {
    return { ok: false, error: 'content is blank: pass the whole document as Markdown' };
  }
  if (text.includes('\0')) {
    return { ok: false, error: 'content must not contain NUL characters' };
  }
  if (!text.endsWith('\n')) text += '\n';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > DOC_CONTENT_MAX_BYTES) {
    return {
      ok: false,
      error: `content is ${bytes.length} bytes as UTF-8, over the limit of ${DOC_CONTENT_MAX_BYTES} bytes (256 KiB); shorten the document`,
    };
  }
  return { ok: true, value: { target: resolveDocPath(cwd, rawPath), bytes } };
}

/** `~` / `~/…` / `~\…` → 用户主目录；绝对路径原样；其余相对会话 cwd */
function resolveDocPath(cwd: string, filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.resolve(os.homedir(), filePath.slice(2));
  }
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
}

// ---------------------------------------------------------------------------
// 文件系统

/** 父目录：已存在必须是真实目录；缺失时只在工作区之内逐级创建 */
async function ensureParent(cwd: string, dir: string): Promise<Parsed<string>> {
  const info = await statIfExists(dir);
  if (info) {
    if (!info.isDirectory()) {
      return { ok: false, error: `${dir} is not a folder, so nothing was written` };
    }
    return { ok: true, value: dir };
  }
  const relative = path.relative(path.resolve(cwd), dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      ok: false,
      error: `the folder ${dir} does not exist; outside the workspace write_doc only writes into existing folders, so check the path`,
    };
  }
  await mkdir(dir, { recursive: true });
  return { ok: true, value: dir };
}

/** 同目录临时文件 + rename 原子新建 / 替换；目标被占用时退回直接覆盖。任何失败都删掉临时文件 */
async function replaceFile(
  dir: string,
  target: string,
  bytes: Buffer,
  existed: boolean
): Promise<void> {
  const temporary = path.join(dir, `.fynvra-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, bytes);
    try {
      await rename(temporary, target);
    } catch (error) {
      // Windows：目标被其他程序打开或杀毒软件占用时 rename 会失败，退回直接覆盖
      if (!existed || !REPLACE_FALLBACK_CODES.has(errorCode(error) ?? '')) throw error;
      await writeFile(target, bytes);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** 独占创建（`wx`）并写入、落盘；写入失败时关闭句柄再抛出（临时文件由调用方删除） */
async function writeExclusive(target: string, bytes: Buffer): Promise<void> {
  const handle: FileHandle = await open(target, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lstatIfExists(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** 跟随链接的 stat（桌面等目录可能本身就是 junction / 重定向） */
async function statIfExists(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
