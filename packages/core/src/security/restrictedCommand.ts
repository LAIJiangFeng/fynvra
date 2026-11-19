import { isProtectedPath, normalizeRepoPath } from './paths';

export type RestrictedCommandResult = { ok: true } | { ok: false; reason: string };
export interface RestrictedCommandOptions {
  mode: 'worker' | 'checks';
}

type Tokenized = { ok: true; segments: string[][] } | { ok: false; reason: string };

const BARE_START = /[A-Za-z0-9._-]/;
// `~` 只允许出现在词中（如 HEAD~1），开头会被 shell 展开成家目录
const BARE_CHAR = /[A-Za-z0-9_./:%+=~-]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截控制字符
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const deny = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

// 白名单很小，所以解析越严越好：任何拿不准的写法都拒绝
function tokenize(command: string): Tokenized {
  if (CONTROL_CHARS.test(command)) {
    return deny('Newlines and control characters are not allowed; run a single-line command.');
  }
  const segments: string[][] = [[]];
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    const current = segments[segments.length - 1] as string[];
    if (ch === ' ') {
      i++;
    } else if (ch === '&') {
      if (command[i + 1] !== '&') {
        return deny('A single "&" is not allowed; chain commands only with "&&".');
      }
      if (current.length === 0) return deny('Empty command segment around "&&".');
      segments.push([]);
      i += 2;
    } else if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end === -1) return deny(`Unclosed ${ch} quote.`);
      const body = command.slice(i + 1, end);
      if (ch === '"' && /[$`\\]/.test(body)) {
        return deny('Double-quoted strings must not contain $, ` or \\; use single quotes.');
      }
      const next = command[end + 1];
      if (next !== undefined && next !== ' ' && next !== '&') {
        return deny('A quoted string must be a whole word; separate it with a space.');
      }
      current.push(body);
      i = end + 1;
    } else if (BARE_START.test(ch)) {
      let end = i;
      while (end < command.length && BARE_CHAR.test(command[end] as string)) end++;
      const next = command[end];
      if (next !== undefined && next !== ' ' && next !== '&') {
        return deny(`Character "${next}" is not allowed in a restricted command.`);
      }
      current.push(command.slice(i, end));
      i = end;
    } else {
      return deny(`Character "${ch}" is not allowed in a restricted command.`);
    }
  }
  if (segments.some((segment) => segment.length === 0)) {
    return deny('Empty command; chain non-empty commands with "&&".');
  }
  return { ok: true, segments };
}

const CHECK_SCRIPTS = new Set(['typecheck', 'lint']);
const INSTALL_FLAGS = ['--frozen-lockfile', '--offline', '--ignore-scripts'];
const GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'rm', 'mv']);
const GIT_FORBIDDEN_SHORT = new Set(['-c', '-C']);
const GIT_FORBIDDEN_LONG = [
  '--exec-path',
  '--ext-diff',
  '--output',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
];
// commit 中这些选项的下一个词是取值，不能当作 -n 之类的开关
const COMMIT_VALUE_OPTIONS = new Set(['-m', '--message', '-F', '--file']);

const CHECKS_HINT = 'Only "pnpm typecheck" and "pnpm lint" (no extra arguments) are allowed.';
const WORKER_HINT =
  'Allowed: pnpm typecheck, pnpm lint, pnpm install --frozen-lockfile --offline --ignore-scripts, ' +
  'git status|diff|log|show|add|commit|rm|mv.';

function checkPnpm(
  args: string[],
  mode: RestrictedCommandOptions['mode']
): RestrictedCommandResult {
  if (args.length === 1 && CHECK_SCRIPTS.has(args[0] as string)) return { ok: true };
  if (mode === 'worker' && args[0] === 'install') {
    const flags = args.slice(1);
    if (flags.length === INSTALL_FLAGS.length && INSTALL_FLAGS.every((f) => flags.includes(f))) {
      return { ok: true };
    }
    return deny(
      'pnpm install must be exactly "pnpm install --frozen-lockfile --offline --ignore-scripts".'
    );
  }
  return deny(
    `"pnpm ${args.join(' ')}" is not allowed. ${mode === 'checks' ? CHECKS_HINT : WORKER_HINT}`
  );
}

function isForbiddenGitOption(arg: string): boolean {
  if (GIT_FORBIDDEN_SHORT.has(arg)) return true;
  if (!arg.startsWith('--') || arg === '--') return false;
  const name = arg.split('=')[0] as string;
  // git 接受长选项的无歧义前缀（如 --out=），所以前缀也要拦
  return name.length > 2 && GIT_FORBIDDEN_LONG.some((option) => option.startsWith(name));
}

function checkGit(args: string[]): RestrictedCommandResult {
  const sub = args[0];
  if (sub === undefined) return deny('A git subcommand is required.');
  if (sub.startsWith('-')) {
    return deny('git global options are not allowed; put the subcommand right after "git".');
  }
  if (!GIT_SUBCOMMANDS.has(sub)) {
    return deny(
      `"git ${sub}" is not allowed. Allowed git subcommands: status, diff, log, show, add, commit, rm, mv.`
    );
  }
  const rest = args.slice(1);
  const forbidden = rest.find(isForbiddenGitOption);
  if (forbidden !== undefined) return deny(`git option "${forbidden}" is not allowed.`);

  if (sub === 'commit') {
    let noVerify = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === '--') break;
      if (COMMIT_VALUE_OPTIONS.has(arg)) i++;
      else if (arg === '--no-verify' || arg === '-n') noVerify = true;
    }
    if (!noVerify)
      return deny('git commit must include --no-verify (e.g. git commit --no-verify -m "...").');
    return { ok: true };
  }

  if (sub === 'add' || sub === 'rm' || sub === 'mv') {
    let afterDashes = false;
    for (const arg of rest) {
      if (!afterDashes && arg === '--') {
        afterDashes = true;
        continue;
      }
      if (!afterDashes && arg.startsWith('-')) continue;
      if (sub === 'add' && arg === '.') continue;
      if (normalizeRepoPath(arg) === null) {
        return deny(`Path "${arg}" must be a relative path inside the repository.`);
      }
      if (sub !== 'add' && isProtectedPath(arg)) {
        return deny(`Path "${arg}" is protected and cannot be removed or moved.`);
      }
    }
  }
  return { ok: true };
}

/** 判定受限会话里的一条命令是否放行；拒绝时 reason 写给模型看（英文）。 */
export function checkRestrictedCommand(
  command: string,
  options: RestrictedCommandOptions
): RestrictedCommandResult {
  const tokenized = tokenize(command);
  if (!tokenized.ok) return tokenized;
  for (const [program, ...args] of tokenized.segments) {
    let result: RestrictedCommandResult;
    if (program === 'pnpm') result = checkPnpm(args, options.mode);
    else if (program === 'git' && options.mode === 'worker') result = checkGit(args);
    else {
      result = deny(
        `"${program}" is not allowed. ${options.mode === 'checks' ? CHECKS_HINT : WORKER_HINT}`
      );
    }
    if (!result.ok) return result;
  }
  return { ok: true };
}
