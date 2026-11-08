import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isPluginProviderName, MAX_REQUESTED_PROVIDERS } from '@shared/types/plugins';

/**
 * 静态扫描插件代码，识别插件按名字查找的模型服务（pi provider 名）。只读文本、用正则匹配，
 * 绝不执行或 import 插件代码；目录插件不跟随符号链接，文件数与大小都有上限。
 */

const SCAN_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const DECLARATION_FILE = /\.d\.[mc]?ts$/i;
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

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
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.rel}\0${file.size}\0${file.mtime}\n`);
  const stamp = hash.digest('hex').slice(0, 32);
  if (previousStamp !== undefined && stamp === previousStamp) return { stamp, names: null };

  const names: string[] = [];
  for (const file of files) {
    if (names.length >= MAX_REQUESTED_PROVIDERS) break;
    if (file.size > MAX_FILE_BYTES) continue;
    let text: string;
    try {
      text = await readFile(file.path, 'utf8');
    } catch {
      continue;
    }
    for (const name of extractProviderNames(text)) {
      if (names.length >= MAX_REQUESTED_PROVIDERS) break;
      if (!names.includes(name)) names.push(name);
    }
  }
  return { stamp, names };
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
