import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { type Static, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  type ArgRecord,
  asRecord,
  compact,
  type Parsed,
  pick,
  requiredText,
  trimmed,
} from './args';
import { errorResult, safely, type ToolResult, textResult } from './result';

export const WRITE_PLAN_TOOL_NAME = 'write_plan';
/** 计划目录，相对会话 cwd（orchestrator 的 cwd 是工作区仓库根目录），POSIX 写法 */
export const PLANS_DIR = '.fynvra/plans';
/** title trim 后的字符数上限（按 Unicode 码点计） */
export const PLAN_TITLE_MAX_CHARS = 200;
/** 计划文件的 UTF-8 字节数上限，与应用内文件编辑器一致（256 KiB） */
export const PLAN_CONTENT_MAX_BYTES = 256 * 1024;

/** 新建文件名里 slug 的字符数上限 */
const SLUG_MAX_CHARS = 48;
const FILE_NAME_MAX_BYTES = 255;
/** 重名时最多试到 `-<n>` */
const MAX_NAME_ATTEMPTS = 1_000;
/** Windows 文件名的保留字符（`:` 会指向 NTFS 备用数据流）与控制字符 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截控制字符
const RESERVED_NAME_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;

/** write_plan 成功结果的 details */
export interface WritePlanDetails {
  /** 计划文件名：之后传给 write_plan 的 `file` */
  file: string;
  /** 相对会话 cwd 的 POSIX 路径（`.fynvra/plans/<file>`） */
  path: string;
  /** true：新建；false：整份替换了已有计划 */
  created: boolean;
  /** 写入的 UTF-8 字节数 */
  bytes: number;
}

const writePlanSchema = Type.Object(
  {
    title: Type.String({
      description: `Short plan title (1–${PLAN_TITLE_MAX_CHARS} characters). It only names a new plan file and is not written into the document, so start content with your own heading.`,
    }),
    content: Type.String({
      description: `The whole plan as one Markdown document, at most ${PLAN_CONTENT_MAX_BYTES / 1024} KiB as UTF-8. With file it replaces that plan in full.`,
    }),
    file: Type.Optional(
      Type.String({
        description:
          'File name returned by an earlier write_plan call, e.g. "20250101-0930-add-login.md": replaces that plan in full. Omit it to create a new plan.',
      })
    ),
  },
  { additionalProperties: false }
);

export interface WritePlanToolOptions {
  /**
   * 计划是本会话唯一能写的文件（orchestrator），工具描述里这样告诉模型。默认 true；
   * 其他会话（计划模式下的非 orchestrator 会话）传 false，描述只说保存计划。
   */
  onlyWritableFile?: boolean;
}

/**
 * write_plan：把计划写成 `<cwd>/.fynvra/plans/` 下的一份 Markdown 文档。注册给 `tools: 'orchestrator'` 的会话，
 * 以及提供了计划模式开关的非 orchestrator、非 worker 会话（见 createRoleSession 的 `planMode`）。
 *
 * 在 agent 进程里直接用 node fs 写：不经 OrchestrationHost / Main（不在 ORCHESTRATION_TOOL_METHODS 里），
 * 也不属于审批门的任何类别（计划模式下也照常可用）。对主 agent 来说它是唯一能写的文件。它只能写计划目录：
 * - `.fynvra` 与 `.fynvra/plans` 必须是真实目录（不是符号链接 / junction / 文件），不存在就逐级创建，
 *   计划目录的 realpath 必须在 realpath(cwd) 之内；
 * - 新建：独占创建（`wx`）`<YYYYMMDD-HHmm>-<slug>.md`（本地时间），重名依次加 `-2`、`-3`…，绝不覆盖；
 * - 更新：`file` 必须是计划目录里已存在的普通文件（纯文件名、lstat），先写同目录临时文件再 rename 原子替换；
 * - UTF-8 无 BOM，以换行结尾；title 只用来生成文件名，不写进正文。
 *
 * execute 永不抛异常，失败以 errorResult 返回。
 */
export function createWritePlanTool(
  cwd: string,
  options: WritePlanToolOptions = {}
): ToolDefinition {
  return defineTool({
    name: WRITE_PLAN_TOOL_NAME,
    label: 'Write plan',
    description:
      `Save a plan as one Markdown document in the workspace under ${PLANS_DIR}/ and return its file name. ` +
      'Without file it creates a new plan file named after the title; with the file name from an earlier result it replaces that plan in full.' +
      (options.onlyWritableFile === false ? '' : ' This is the only file you can write.'),
    promptSnippet: `Save or replace a Markdown plan document in ${PLANS_DIR}/`,
    parameters: writePlanSchema,
    executionMode: 'sequential',
    prepareArguments: (raw) => normalizeWritePlanArgs(raw) as Static<typeof writePlanSchema>,
    execute: (_toolCallId, params) => safely(WRITE_PLAN_TOOL_NAME, () => writePlan(cwd, params)),
  });
}

interface PlanInput {
  title: string;
  /** 要写入的内容：UTF-8、无 BOM、以换行结尾 */
  bytes: Buffer;
  /** 要整份替换的计划文件名；缺省新建 */
  file?: string;
}

async function writePlan(cwd: string, params: unknown): Promise<ToolResult> {
  const input = parseWritePlanArgs(params);
  if (!input.ok) return errorResult(WRITE_PLAN_TOOL_NAME, input.error);
  const { title, bytes, file } = input.value;
  const create = file === undefined;
  const dir = await planDirectory(cwd, create);
  if (!dir.ok) return errorResult(WRITE_PLAN_TOOL_NAME, dir.error);
  const saved = create
    ? await createPlan(dir.value, `${timestamp(new Date())}-${planSlug(title)}`, bytes)
    : await replacePlan(dir.value, file, bytes);
  if (!saved.ok) return errorResult(WRITE_PLAN_TOOL_NAME, saved.error);
  return savedResult(saved.value, create, bytes.length);
}

// ---------------------------------------------------------------------------
// 参数归一化（prepareArguments）与语义校验（execute）

function normalizeWritePlanArgs(raw: unknown): ArgRecord {
  const args = asRecord(raw);
  const file = trimmed(pick(args, 'file', 'file_name', 'fileName', 'filename'));
  return compact({
    title: trimmed(pick(args, 'title')),
    // 正文原样保留（Markdown 的首尾空白可能有意义），只在 execute 里去 BOM、补结尾换行
    content: pick(args, 'content'),
    file: file === '' ? undefined : file,
  });
}

function parseWritePlanArgs(params: unknown): Parsed<PlanInput> {
  const args = normalizeWritePlanArgs(params);
  const title = requiredText(args.title, 'title');
  if (!title.ok) return title;
  const titleChars = [...title.value].length;
  if (titleChars > PLAN_TITLE_MAX_CHARS) {
    return {
      ok: false,
      error: `title must be at most ${PLAN_TITLE_MAX_CHARS} characters (got ${titleChars}); it only names the file, so keep it short`,
    };
  }
  if (args.content === undefined) {
    return { ok: false, error: 'content is required: the whole plan as one Markdown document' };
  }
  if (typeof args.content !== 'string') {
    return { ok: false, error: 'content must be a string of Markdown' };
  }
  let text = args.content.startsWith('\uFEFF') ? args.content.slice(1) : args.content;
  if (!text.trim()) {
    return { ok: false, error: 'content is blank: pass the whole plan as one Markdown document' };
  }
  if (text.includes('\0')) {
    return { ok: false, error: 'content must not contain NUL characters' };
  }
  if (!text.endsWith('\n')) text += '\n';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > PLAN_CONTENT_MAX_BYTES) {
    return {
      ok: false,
      error: `content is ${bytes.length} bytes as UTF-8, over the limit of ${PLAN_CONTENT_MAX_BYTES} bytes (256 KiB); shorten the plan`,
    };
  }
  const file = args.file;
  if (file === undefined) return { ok: true, value: { title: title.value, bytes } };
  if (typeof file !== 'string' || !isPlainPlanName(file)) {
    return {
      ok: false,
      error: `file must be the plain name of a plan in ${PLANS_DIR}/ as returned by write_plan, e.g. "20250101-0930-add-login.md" (no directories, ending in .md); omit file to create a new plan`,
    };
  }
  return { ok: true, value: { title: title.value, bytes, file } };
}

/** 更新用的 file：纯文件名，不含 `/`、`\`、`..`，不以 `.` 开头，以 `.md` 结尾，不超过 255 字节 */
function isPlainPlanName(file: string): boolean {
  return (
    !file.includes('/') &&
    !file.includes('\\') &&
    !file.includes('..') &&
    !file.startsWith('.') &&
    file.endsWith('.md') &&
    Buffer.byteLength(file, 'utf8') <= FILE_NAME_MAX_BYTES &&
    !RESERVED_NAME_CHARS.test(file)
  );
}

// ---------------------------------------------------------------------------
// 文件系统

/**
 * 计划目录 `<realpath(cwd)>/.fynvra/plans`：逐级 lstat，已存在但不是真实目录（符号链接 / junction / 文件）就拒绝；
 * 不存在时 `create` 才创建（更新已有计划时缺目录就是文件不存在）。最后核对 realpath 在 realpath(cwd) 之内。
 */
async function planDirectory(cwd: string, create: boolean): Promise<Parsed<string>> {
  const root = await realpath(cwd);
  let dir = root;
  let shown = '';
  for (const segment of PLANS_DIR.split('/')) {
    dir = path.join(dir, segment);
    shown = shown ? `${shown}/${segment}` : segment;
    let info = await lstatIfExists(dir);
    if (!info) {
      if (!create) return { ok: false, error: missingPlan(`${PLANS_DIR}/`) };
      try {
        await mkdir(dir);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      info = await lstat(dir);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        ok: false,
        error: `${shown} in the workspace is not a real directory (it is a symbolic link, junction or file), so no plan was written; ask the user to move it out of the way`,
      };
    }
  }
  const real = await realpath(dir);
  const relative = path.relative(root, real);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return {
      ok: false,
      error: `${PLANS_DIR} resolves outside the workspace (${real}), so no plan was written`,
    };
  }
  return { ok: true, value: real };
}

/** 新建：`<stem>.md`，重名依次试 `<stem>-2.md`、`<stem>-3.md`…；独占创建，绝不覆盖已有文件 */
async function createPlan(dir: string, stem: string, bytes: Buffer): Promise<Parsed<string>> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? `${stem}.md` : `${stem}-${attempt}.md`;
    if (await writeExclusive(path.join(dir, name), bytes)) return { ok: true, value: name };
  }
  return {
    ok: false,
    error: `${PLANS_DIR}/ already has too many plans named ${stem}; use a different title`,
  };
}

/** 更新：目标必须是已存在的普通文件；写同目录临时文件后 rename 原子替换（不跟随链接，也不改硬链接的另一端） */
async function replacePlan(dir: string, name: string, bytes: Buffer): Promise<Parsed<string>> {
  const target = path.join(dir, name);
  const info = await lstatIfExists(target);
  if (!info) return { ok: false, error: missingPlan(`${PLANS_DIR}/${name}`) };
  if (!info.isFile()) {
    return {
      ok: false,
      error: `${PLANS_DIR}/${name} is not a regular file (it is a directory or a symbolic link), so it was not replaced`,
    };
  }
  // 以 . 开头：不会和计划文件名（不能以 . 开头）冲突
  const temporary = path.join(dir, `.fynvra-${randomUUID()}.tmp`);
  if (!(await writeExclusive(temporary, bytes))) {
    throw new Error(`the temporary file ${temporary} already exists`);
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { ok: true, value: name };
}

/** 独占创建（`wx`）并写入、落盘；目标已存在时返回 false。写入失败时删掉写了一半的文件再抛出 */
async function writeExclusive(target: string, bytes: Buffer): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(target, 'wx');
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false;
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

async function lstatIfExists(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

function missingPlan(what: string): string {
  return `${what} does not exist. Omit file to create a new plan, or pass the exact file name an earlier write_plan result gave.`;
}

// ---------------------------------------------------------------------------
// 文件名与结果

/** 本地时间 `YYYYMMDD-HHmm` */
function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * 文件名里的 slug：NFKC、小写，保留 Unicode 字母和数字（中文标题保留中文），其他连续字符换成一个 `-`，
 * 去掉首尾 `-`，最多 48 个字符（按码点截断），为空时用 `plan`。
 */
function planSlug(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return [...slug].slice(0, SLUG_MAX_CHARS).join('').replace(/-+$/, '') || 'plan';
}

/** 成功结果是 Markdown（Renderer 按 Markdown 渲染编排类工具的输出）：指向文件的相对链接和后续修改方法 */
function savedResult(name: string, created: boolean, bytes: number): ToolResult {
  const relative = `${PLANS_DIR}/${name}`;
  const details: WritePlanDetails = { file: name, path: relative, created, bytes };
  return textResult(
    [
      `Plan saved to [${linkLabel(relative)}](${linkTarget(relative)}) (${created ? 'created' : 'updated'}).`,
      `To revise it, call write_plan again with file: ${JSON.stringify(name)}.`,
    ].join('\n'),
    details
  );
}

/** 链接文字：转义会被当成 Markdown 语法的字符 */
function linkLabel(text: string): string {
  return text.replace(/[\\`*_[\]]/g, '\\$&');
}

/**
 * 链接目标：空白、括号、`<>`、`[]`、`#`、`?`、`%` 会截断 Markdown 链接或被当成 URL 参数，按 UTF-8 百分号编码
 * （Renderer 打开前会解码）。新建的文件名只有字母、数字和 `-`，原样保留。
 */
function linkTarget(relative: string): string {
  return relative.replace(/[\s()<>[\]#?%]/gu, (char) =>
    char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char)
  );
}
