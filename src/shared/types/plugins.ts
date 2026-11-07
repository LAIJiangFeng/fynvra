/** 插件来源类型：本地目录 / 扩展文件，或经 pi 包管理器安装的 npm / git 包 */
export type PluginKind = 'local' | 'npm' | 'git';

/** plugins.json 里的一条记录；path 是 pi 包目录或单个扩展文件（.ts / .js / .mjs）的绝对路径 */
export interface PluginEntry {
  id: string;
  name: string;
  /** 本地插件为绝对路径；远程插件为用户输入的 npm: / git: / https:// 来源 */
  source: string;
  kind: PluginKind;
  path: string;
  enabled: boolean;
  /** 登记时间（epoch ms） */
  installedAt: number;
}

/** 远程来源的最大长度（去首尾空白后） */
export const MAX_PLUGIN_SOURCE_LENGTH = 500;

/**
 * 校验 npm / git 来源：去首尾空白后 1–500 字符，不含换行、空字符和空白；只接受
 * `npm:<name>[@version]`、`git:<host>/<path>[@ref]`、`https://` 仓库 URL。合法时返回规整后的来源与类型。
 */
export function parseRemotePluginSource(
  raw: unknown
): { source: string; kind: 'npm' | 'git' } | null {
  if (typeof raw !== 'string') return null;
  const source = raw.trim();
  if (!source || source.length > MAX_PLUGIN_SOURCE_LENGTH) return null;
  if (/[\s\0]/.test(source)) return null;
  if (source.startsWith('npm:')) {
    return NPM_SPEC.test(source.slice(4)) ? { source, kind: 'npm' } : null;
  }
  if (source.startsWith('git:')) {
    return GIT_SPEC.test(source.slice(4)) ? { source, kind: 'git' } : null;
  }
  if (source.startsWith('https://')) {
    try {
      const url = new URL(source);
      return url.hostname && url.pathname.length > 1 && !url.username && !url.password
        ? { source, kind: 'git' }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `name` 或 `@scope/name`，可带 `@version`；不允许以 `-` 开头（防止被当作命令行参数） */
const NPM_SPEC = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~<>=*|+-]+)?$/i;
/** `<host>/<path>[@ref]` */
const GIT_SPEC = /^[a-z0-9][\w.-]*(?::\d+)?\/[\w.~/-]+(?:@[\w./-]+)?$/i;
