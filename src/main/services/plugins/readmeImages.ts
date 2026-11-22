// README 图片（plugins:readme-image）：只加载最近一次读到的 README 里原样出现过的地址。
// 相对路径从插件目录读文件（不越界、不跟随符号链接），https 地址经 agent-runtime 的安全传输下载；
// 都按文件头校验类型、有大小上限，返回 data URL。错误只带错误码，不带本机路径。
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import type { FetchedPage } from '@fynvra/agent-runtime';
import {
  type PluginReadmeImageResult,
  type ReadmeSource,
  readmeSourceKey,
} from '@shared/types/plugins';
import { sniffImage } from '../channels/attachments';

export const README_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const README_SVG_MAX_BYTES = 512 * 1024;
const README_CACHE_MAX = 20;
const README_CACHE_TTL_MS = 10 * 60 * 1000;

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SVG_TYPE = 'image/svg+xml';

/** 最近读过的 README 文本：键为 readmeSourceKey，Map 的插入顺序即 LRU 顺序 */
const readmes = new Map<string, { text: string; at: number }>();

/** 三个 README 通道成功返回时调用，记下文本供图片请求核对 */
export function rememberReadme(source: ReadmeSource, text: string, now = Date.now()): void {
  const key = readmeSourceKey(source);
  readmes.delete(key);
  readmes.set(key, { text, at: now });
  while (readmes.size > README_CACHE_MAX) {
    const oldest = readmes.keys().next().value;
    if (oldest === undefined) break;
    readmes.delete(oldest);
  }
}

function cachedReadme(source: ReadmeSource, now: number): string | null {
  const key = readmeSourceKey(source);
  const entry = readmes.get(key);
  if (!entry) return null;
  if (now - entry.at > README_CACHE_TTL_MS) {
    readmes.delete(key);
    return null;
  }
  return entry.text;
}

/** 地址须原样出现在 README 里（HTML 属性里的 & 可能写成 &amp;） */
function appearsIn(text: string, src: string): boolean {
  return text.includes(src) || (src.includes('&') && text.includes(src.replaceAll('&', '&amp;')));
}

export interface ReadmeImageDeps {
  /** 已装插件的目录（只用于 fynvra / pi）；找不到返回 null */
  pluginDir(source: { kind: 'fynvra' | 'pi'; id: string }): Promise<string | null>;
  /**
   * 已装插件对应的市场版本：插件目录没有 README 时详情页显示的是市场版本的 README，
   * 其中的相对路径仍从已装目录读取
   */
  marketOf?(source: { kind: 'fynvra' | 'pi'; id: string }): Promise<ReadmeSource | null>;
  /** https 下载：调用方须保证只走 https、限制重定向 / 超时 / 大小，不带凭据 */
  fetchImage(url: URL): Promise<Pick<FetchedPage, 'contentType' | 'body' | 'truncated'>>;
  now?: () => number;
}

type Failure = Extract<PluginReadmeImageResult, { ok: false }>;
const fail = (code: Failure['code']): Failure => ({ ok: false, code });

export async function loadReadmeImage(
  input: { source: ReadmeSource; src: string },
  deps: ReadmeImageDeps
): Promise<PluginReadmeImageResult> {
  const { source, src } = input;
  if (!(await readmeContains(source, src, deps))) return fail('not-in-readme');
  if (/^https:\/\//i.test(src)) return loadRemote(src, deps);
  // 带协议（http:、data:、file: 等）或协议相对地址一律不处理；data: 由 Renderer 自己显示
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return fail('unsupported');
  if (source.kind === 'market') return fail('unsupported');
  const segments = relativeSegments(src);
  if (!segments) return fail('invalid');
  try {
    const dir = await deps.pluginDir(source);
    if (!dir) return fail('not-found');
    return await readLocal(dir, segments);
  } catch {
    return fail('failed');
  }
}

async function readmeContains(
  source: ReadmeSource,
  src: string,
  deps: ReadmeImageDeps
): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  const text = cachedReadme(source, now);
  if (text !== null && appearsIn(text, src)) return true;
  if (source.kind === 'market' || !deps.marketOf) return false;
  const market = await deps.marketOf(source).catch(() => null);
  const marketText = market ? cachedReadme(market, now) : null;
  return marketText !== null && appearsIn(marketText, src);
}

/**
 * 相对路径 → 路径段：先 percent-decode，再拒绝绝对路径、盘符、`..`、反斜杠、`~`、冒号（ADS）、
 * 空段、查询串与锚点、控制字符。`.` 段直接跳过。
 */
export function relativeSegments(src: string): string[] | null {
  if (/[?#]/.test(src)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 拒绝路径里的控制字符
  if (/[\\:?#~\u0000-\u001f]/.test(decoded) || decoded.startsWith('/')) return null;
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '..') return null;
    if (segment !== '.') segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

async function readLocal(dir: string, segments: string[]): Promise<PluginReadmeImageResult> {
  const realDir = await realpath(dir);
  const path = join(realDir, ...segments);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return fail('not-found');
  }
  if (!info.isFile()) return fail('unsupported');
  const real = await realpath(path);
  const inside = relative(realDir, real);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return fail('invalid');
  if (info.size > README_IMAGE_MAX_BYTES) return fail('too-large');
  const bytes = await readFile(real);
  // lstat 与读取之间文件可能被替换，读完再校验一次大小
  if (bytes.length > README_IMAGE_MAX_BYTES) return fail('too-large');
  const isSvg = extname(real).toLowerCase() === '.svg';
  return toDataUrl(bytes, isSvg ? SVG_TYPE : null);
}

/**
 * shortcut: DNS 重绑定的防护取决于 agent-runtime 的 transport：直连时按解析后的地址连接并检查，
 * 走代理时只能在本地预检（代理自行解析），有残余风险；若要彻底防住需改为由代理侧限制目标。
 */
async function loadRemote(src: string, deps: ReadmeImageDeps): Promise<PluginReadmeImageResult> {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return fail('invalid');
  }
  if (url.protocol !== 'https:') return fail('unsupported');
  let page: Awaited<ReturnType<ReadmeImageDeps['fetchImage']>>;
  try {
    page = await deps.fetchImage(url);
  } catch {
    return fail('failed');
  }
  if (page.truncated || page.body.length > README_IMAGE_MAX_BYTES) return fail('too-large');
  const type = page.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === SVG_TYPE) return toDataUrl(page.body, SVG_TYPE);
  if (!ALLOWED_TYPES.has(type)) return fail('unsupported');
  const result = toDataUrl(page.body, null);
  // Content-Type 与文件头必须一致
  return result.ok && !result.dataUrl.startsWith(`data:${type};`) ? fail('unsupported') : result;
}

/** svgHint 为 image/svg+xml 时按 SVG 文本校验，否则按文件头识别位图 */
function toDataUrl(bytes: Buffer, svgHint: typeof SVG_TYPE | null): PluginReadmeImageResult {
  if (svgHint) {
    if (bytes.length > README_SVG_MAX_BYTES) return fail('too-large');
    const head = bytes
      .subarray(0, 256)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart();
    if (!head.startsWith('<svg') && !head.startsWith('<?xml')) return fail('unsupported');
    return { ok: true, dataUrl: `data:${SVG_TYPE};base64,${bytes.toString('base64')}` };
  }
  const type = sniffImage(bytes);
  if (!type || !ALLOWED_TYPES.has(type)) return fail('unsupported');
  return { ok: true, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
}
