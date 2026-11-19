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
    } else {
      out.push(segment);
    }
  }
  return out.length === 0 ? null : out.join('/');
}

const PROTECTED_NAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  '.npmrc',
  'biome.json',
  'biome.jsonc',
]);
const PROTECTED_ROOT_DIRS = new Set(['.github', 'patches', 'scripts', '.husky']);

/** 受限会话不可写的路径（不区分大小写；无法规范化的路径按受保护处理）。 */
export function isProtectedPath(rel: string): boolean {
  const normalized = normalizeRepoPath(rel);
  if (normalized === null) return true;
  const segments = normalized.toLowerCase().split('/');
  if (PROTECTED_ROOT_DIRS.has(segments[0] ?? '')) return true;
  if (segments.includes('.git')) return true;
  const name = segments[segments.length - 1] ?? '';
  return (
    PROTECTED_NAMES.has(name) ||
    /^tsconfig.*\.json$/.test(name) ||
    name.includes('.config.') ||
    /^electron-builder.*\.ya?ml$/.test(name)
  );
}

const SENSITIVE_NAMES = new Set(['.env', '.npmrc', '.netrc', '_netrc']);
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'];

/** 受限会话不可读写的敏感文件（不区分大小写，任意层级的名字命中即算）。 */
export function isSensitivePath(rel: string): boolean {
  return rel
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .some(
      (name) =>
        SENSITIVE_NAMES.has(name) ||
        name.startsWith('.env.') ||
        SENSITIVE_EXTENSIONS.some((ext) => name.endsWith(ext)) ||
        /^id_[a-z0-9_-]+(\.pub)?$/.test(name)
    );
}
