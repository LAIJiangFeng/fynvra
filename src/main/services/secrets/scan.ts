// 密钥与本机信息检测（ARCHITECTURE §7.14）：纯函数，只返回命中类别，绝不返回命中的值。

export interface SecretScanResult {
  hit: boolean;
  kinds: string[];
}

const SECRET_PATTERNS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['sk-key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['github-token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['telegram-bot-token', /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];

/** 查已知密钥（精确子串）与常见密钥格式。 */
export function scanSecrets(text: string, known: readonly string[]): SecretScanResult {
  const kinds: string[] = [];
  if (known.some((value) => value !== '' && text.includes(value))) kinds.push('known-secret');
  for (const [kind, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) kinds.push(kind);
  }
  return { hit: kinds.length > 0, kinds };
}

export const REDACTED_SECRET = '[已移除密钥]';

/** 替换用的格式：私钥要吃掉整块（到 END 行或文本末尾），其余与 SECRET_PATTERNS 同形 */
const REDACT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  ...SECRET_PATTERNS.filter(([kind]) => kind !== 'private-key').map(
    ([, pattern]) => new RegExp(pattern.source, 'g')
  ),
];

/** 把已知密钥值（精确子串，长的先换）与常见密钥格式替换为 `[已移除密钥]`。 */
export function redactSecrets(text: string, known: readonly string[]): string {
  let out = text;
  for (const value of [...known].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(value).join(REDACTED_SECRET);
  }
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, REDACTED_SECRET);
  return out;
}

export interface LocalInfoContext {
  /** 本机绝对路径前缀：主目录、userData、各工作区、worktrees 根目录 */
  paths: readonly string[];
  userName?: string;
  hostName?: string;
  /** 按 Windows 规则匹配（不区分大小写）；缺省按当前平台 */
  windows?: boolean;
}

const PLACEHOLDERS = { path: '<本机路径>', 'user-name': '<用户名>', 'host-name': '<主机名>' };
type LocalKind = keyof typeof PLACEHOLDERS;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 本机信息的匹配规则；路径按长度降序，替换时先吃掉最长的前缀。 */
function localPatterns(ctx: LocalInfoContext): [LocalKind, RegExp][] {
  const flags = (ctx.windows ?? process.platform === 'win32') ? 'gi' : 'g';
  const patterns: [LocalKind, RegExp][] = [];
  const paths = [...new Set(ctx.paths.map((path) => path.replace(/[\\/]+$/, '')))]
    // 根目录（`/`、`C:`）会命中一切，跳过
    .filter((path) => path !== '' && !/^[A-Za-z]:$/.test(path))
    .sort((a, b) => b.length - a.length);
  for (const path of paths) {
    // `\` 与 `/` 视为同一种分隔符，也兼容 JSON 里转义成 `\\` 的写法
    const body = path
      .split(/[\\/]+/)
      .map(escapeRegExp)
      .join('[\\\\/]+');
    patterns.push(['path', new RegExp(`${body}(?![A-Za-z0-9_.-])`, flags)]);
  }
  for (const [kind, word] of [
    ['user-name', ctx.userName],
    ['host-name', ctx.hostName],
  ] as const) {
    const name = word?.trim();
    // 过短的名字容易误报，不处理
    if (name === undefined || name.length < 3) continue;
    patterns.push([
      kind,
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, flags),
    ]);
  }
  return patterns;
}

/** 查本机绝对路径、用户名、主机名；只返回类别（path / user-name / host-name）。 */
export function findLocalInfo(text: string, ctx: LocalInfoContext): SecretScanResult {
  const kinds = new Set<string>();
  for (const [kind, pattern] of localPatterns(ctx)) {
    if (pattern.test(text)) kinds.add(kind);
  }
  return { hit: kinds.size > 0, kinds: [...kinds] };
}

/** 把本机路径、用户名、主机名替换成占位符。 */
export function sanitizeLocalInfo(text: string, ctx: LocalInfoContext): string {
  let out = text;
  for (const [kind, pattern] of localPatterns(ctx)) out = out.replace(pattern, PLACEHOLDERS[kind]);
  return out;
}
