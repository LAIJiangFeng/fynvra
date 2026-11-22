import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { asRecord } from '@shared/guards';
import {
  isPluginProviderName,
  MAX_PLUGIN_DESCRIPTION_LENGTH,
  MAX_REQUESTED_PROVIDERS,
} from '@shared/types/plugins';

/**
 * 静态扫描插件代码，识别插件按名字查找的模型服务（pi provider 名）。只读文本、用正则匹配，
 * 绝不执行或 import 插件代码；目录插件不跟随符号链接，文件数与大小都有上限。
 */

const SCAN_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const DECLARATION_FILE = /\.d\.[mc]?ts$/i;
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
/** package.json / 清单的大小上限 */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** 扫描格式版本：加进 stamp 的哈希输入，改了扫描内容就换版本，让已有插件重新扫描 */
const SCAN_FORMAT = 'scan-v2';

/**
 * 只读普通文件（lstat 判断，不跟随符号链接）且不超过 maxBytes 的文本；不是普通文件或超长返回 undefined。
 * lstat / 读取失败时 reject（错误可能带路径，调用方只记错误码）。
 */
export async function readSmallTextFile(
  path: string,
  maxBytes: number
): Promise<string | undefined> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes) return undefined;
  return readFile(path, 'utf8');
}

/** trim 后为空返回 undefined；超过 300 字截断并加「…」 */
export function clampDescription(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (text.length <= MAX_PLUGIN_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_PLUGIN_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

/**
 * 单文件插件开头的注释作简介：跳过 BOM 与 shebang，取第一段 `/** … *\/`、`/* … *\/` 或连续的 `//` 行；
 * 去掉注释符号，只取第一段（空行分段），合并空白
 */
export function extractHeaderComment(source: string): string | undefined {
  let text = source.replace(/^\uFEFF/, '');
  if (text.startsWith('#!')) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  text = text.trimStart();
  let lines: string[];
  if (text.startsWith('/*')) {
    const end = text.indexOf('*/', 2);
    if (end < 0) return undefined;
    lines = text
      .slice(2, end)
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*+/, ''));
  } else if (text.startsWith('//')) {
    lines = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*\/\/+(.*)$/.exec(line);
      if (!match) break;
      lines.push(match[1] as string);
    }
  } else {
    return undefined;
  }
  const paragraph = lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return paragraph ? clampDescription(paragraph) : undefined;
}

/** 目录插件根目录 package.json 的 description；读不到、不是普通文件、超长或 JSON 解析失败都忽略 */
async function readPackageDescription(dir: string): Promise<string | undefined> {
  try {
    const text = await readSmallTextFile(join(dir, 'package.json'), MAX_MANIFEST_BYTES);
    if (text === undefined) return undefined;
    const description = asRecord(JSON.parse(text))?.description;
    return typeof description === 'string' ? clampDescription(description) : undefined;
  } catch {
    return undefined;
  }
}

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
/** 字符串字面量（单 / 双引号，或不含插值的反引号）或标识符；捕获组依次为 ' " ` 和标识符 */
const ARG = String.raw`(?:'([^'\\\r\n]*)'|"([^"\\\r\n]*)"|\`([^\`\\$]*)\`|(?<![\w$.])(${IDENT}))`;

/** `const|let|var NAME[: Type] = '...'` */
const CONSTANT = new RegExp(
  String.raw`\b(?:const|let|var)\s+(${IDENT})\s*(?::[^=;\r\n]+)?=\s*(?:'([^'\\\r\n]*)'|"([^"\\\r\n]*)"|\`([^\`\\$]*)\`)`,
  'g'
);
/** 按名字查找服务的调用与比较；第一个 ARG 是服务名 */
const USAGES = [
  new RegExp(
    String.raw`\.(?:getProvider|getProviderAuth|getApiKeyForProvider|getProviderAuthStatus)\s*\(\s*${ARG}\s*[,)]`,
    'g'
  ),
  new RegExp(String.raw`\.find\s*\(\s*${ARG}\s*,`, 'g'),
  new RegExp(String.raw`\.provider\s*===?\s*${ARG}`, 'g'),
  new RegExp(String.raw`${ARG}\s*===?\s*${IDENT}(?:\??\.${IDENT})*\??\.provider\b`, 'g'),
];

/** 从一段源码里提取服务名：去重、按首次出现排序、最多 20 个；不合法的名字丢弃 */
export function extractProviderNames(source: string): string[] {
  const constants = new Map<string, string>();
  for (const match of source.matchAll(CONSTANT)) {
    const name = match[1] as string;
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined && !constants.has(name)) constants.set(name, value);
  }

  const found: { index: number; name: string }[] = [];
  for (const pattern of USAGES) {
    for (const match of source.matchAll(pattern)) {
      const literal = match[1] ?? match[2] ?? match[3];
      const name = literal ?? (match[4] !== undefined ? constants.get(match[4]) : undefined);
      if (isPluginProviderName(name)) found.push({ index: match.index, name });
    }
  }
  found.sort((a, b) => a.index - b.index);

  const names: string[] = [];
  for (const { name } of found) {
    if (names.length >= MAX_REQUESTED_PROVIDERS) break;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface PluginProviderScan {
  /** 被扫描文件（相对路径 + 大小 + mtime）的哈希 */
  stamp: string;
  /** stamp 与传入的 previousStamp 相同时为 null（未重新读取文件） */
  names: string[] | null;
  /** 简介（目录插件取 package.json，单文件取开头注释）；names 为 null 时不读，始终没有 */
  description?: string;
}

interface ScanFile {
  path: string;
  rel: string;
  size: number;
  mtime: number;
}

/**
 * 扫描单文件插件或目录插件。传入 previousStamp 且文件没变时只做 stat，不读内容。
 * 抛出的错误可能带路径，调用方记录日志时只取错误码。
 */
export async function scanPluginProviders(
  pluginPath: string,
  previousStamp?: string
): Promise<PluginProviderScan> {
  const files = await collectFiles(pluginPath);
  const isDir = (await stat(pluginPath)).isDirectory();
  const hash = createHash('sha256');
  hash.update(`${SCAN_FORMAT}\n`);
  if (isDir) {
    // package.json 不在被扫文件里，单独计入 stamp，简介改了也能重新扫描
    const pkg = await lstat(join(pluginPath, 'package.json')).catch(() => null);
    if (pkg) hash.update(`package.json\0${pkg.size}\0${Math.trunc(pkg.mtimeMs)}\n`);
  }
  for (const file of files) hash.update(`${file.rel}\0${file.size}\0${file.mtime}\n`);
  const stamp = hash.digest('hex').slice(0, 32);
  if (previousStamp !== undefined && stamp === previousStamp) return { stamp, names: null };

  const names: string[] = [];
  let description = isDir ? await readPackageDescription(pluginPath) : undefined;
  for (const file of files) {
    if (names.length >= MAX_REQUESTED_PROVIDERS) break;
    if (file.size > MAX_FILE_BYTES) continue;
    let text: string;
    try {
      text = await readFile(file.path, 'utf8');
    } catch {
      continue;
    }
    // 单文件插件的 rel 为空串
    if (!isDir && file.rel === '') description = extractHeaderComment(text);
    for (const name of extractProviderNames(text)) {
      if (names.length >= MAX_REQUESTED_PROVIDERS) break;
      if (!names.includes(name)) names.push(name);
    }
  }
  return { stamp, names, ...(description !== undefined ? { description } : {}) };
}

async function collectFiles(root: string): Promise<ScanFile[]> {
  const info = await stat(root);
  if (info.isFile()) {
    return [{ path: root, rel: '', size: info.size, mtime: Math.trunc(info.mtimeMs) }];
  }
  if (!info.isDirectory()) return [];

  const files: ScanFile[] = [];
  let total = 0;
  const walk = async (dir: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      // Dirent 不跟随符号链接：链接既不是 isFile 也不是 isDirectory
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (!(await walk(full))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!SCAN_EXTENSIONS.some((ext) => lower.endsWith(ext)) || DECLARATION_FILE.test(lower)) {
        continue;
      }
      const fileInfo = await lstat(full).catch(() => null);
      if (!fileInfo?.isFile()) continue;
      if (fileInfo.size <= MAX_FILE_BYTES) {
        if (total + fileInfo.size > MAX_TOTAL_BYTES) return false;
        total += fileInfo.size;
      }
      files.push({
        path: full,
        rel: relative(root, full).replaceAll('\\', '/'),
        size: fileInfo.size,
        mtime: Math.trunc(fileInfo.mtimeMs),
      });
      if (files.length >= MAX_FILES) return false;
    }
    return true;
  };
  await walk(root);
  return files;
}
