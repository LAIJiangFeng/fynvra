// 受限会话的路径规则：输入是相对仓库根的路径，纯字符串处理，Windows/POSIX 通用。

// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截控制字符
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 规范化相对仓库根的路径；绝对路径、越界、空串、含控制字符时返回 null。 */
export function normalizeRepoPath(raw: string): string | null {
  if (raw === '' || CONTROL_CHARS.test(raw)) return null;
  const path = raw.replace(/\\/g, '/');
  // `/` 开头同时覆盖 UNC（`\\server` 已变成 `//server`）
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) return null;
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else if (/[:<>"|?*]/.test(segment) || /[. ]$/.test(segment)) {
      // Windows 别名：ADS（x::$DATA）与末尾的 . 或空格都会落到另一个文件上
      return null;
    } else {
      out.push(segment);
    }
  }
  return out.length === 0 ? null : out.join('/');
}

// NTFS 先转大写再比较：ſ、ı、K（Kelvin）等经大写后与 s、i、k 同名
const foldCase = (s: string): string => s.toUpperCase().toLowerCase();

const PROTECTED_NAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'pnpm-workspace.yaml',
  '.npmrc',
  'biome.json',
  'biome.jsonc',
  'node_modules',
  '.gitattributes',
  '.gitmodules',
  'agents.md',
  'claude.md',
]);
// 8.3 短名（如 PACKAG~1.JSO、GITHUB~1）可能指向任意长名，按命中处理
const SHORT_NAME = /~\d/;
const PROTECTED_ROOT_DIRS = new Set(['.github', 'patches', 'scripts', '.husky']);

/** 受限会话不可写的路径（不区分大小写；无法规范化的路径按受保护处理）。 */
export function isProtectedPath(rel: string): boolean {
  const normalized = normalizeRepoPath(rel);
  if (normalized === null) return true;
  const segments = foldCase(normalized).split('/');
  if (PROTECTED_ROOT_DIRS.has(segments[0] ?? '')) return true;
  // 任意层级的名字命中即受保护（含 .git、node_modules 这类目录下的一切）
  return segments.some(
    (name) =>
      name === '.git' ||
      SHORT_NAME.test(name) ||
      PROTECTED_NAMES.has(name) ||
      name.startsWith('.pnpmfile.') ||
      /^\.[^/]*rc(\.[^/]+)?$/.test(name) ||
      /^tsconfig.*\.json$/.test(name) ||
      name.includes('.config.') ||
      /^electron-builder.*\.ya?ml$/.test(name)
  );
}

const SENSITIVE_NAMES = new Set(['.env', '.npmrc', '.netrc', '_netrc']);
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'];

/** 受限会话不可读写的敏感文件（不区分大小写，任意层级的名字命中即算）。 */
export function isSensitivePath(rel: string): boolean {
  return matchesSensitiveName(rel, true);
}

/**
 * 敏感文件判定的内部实现（不从包入口导出）。
 * shortNames=false 供 git 参数检查用：git 按跟踪的确切文件名匹配，且 HEAD~1 必须放行。
 */
export function matchesSensitiveName(rel: string, shortNames: boolean): boolean {
  return foldCase(rel.replace(/\\/g, '/'))
    .split('/')
    .map((segment) => segment.replace(/[. ]+$/, ''))
    .some(
      (name) =>
        name.includes(':') ||
        (shortNames && SHORT_NAME.test(name)) ||
        SENSITIVE_NAMES.has(name) ||
        name.startsWith('.env.') ||
        SENSITIVE_EXTENSIONS.some((ext) => name.endsWith(ext)) ||
        /^id_[a-z0-9_-]+(\.pub)?$/.test(name)
    );
}
