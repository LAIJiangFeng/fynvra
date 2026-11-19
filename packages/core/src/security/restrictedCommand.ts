import { isProtectedPath, isSensitivePath, matchesSensitiveName, normalizeRepoPath } from './paths';

export type RestrictedCommandResult = { ok: true } | { ok: false; reason: string };
export interface RestrictedCommandOptions {
  mode: 'worker' | 'checks';
}

type Tokenized = { ok: true; segments: string[][] } | { ok: false; reason: string };

const BARE_START = /[A-Za-z0-9._-]/;
// `~` 只允许出现在词中（如 HEAD~1），开头会被 shell 展开成家目录
const BARE_CHAR = /[A-Za-z0-9_./:%+=~-]/;
// 控制字符、零宽/双向控制字符，以及 PowerShell 视作引号的 Unicode 引号（U+2018–U+201F），引号内也不放行
const FORBIDDEN_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截控制字符
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2018-\u201f\u2028-\u202e\u2066-\u2069\ufeff]/;

const deny = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

// 白名单很小，所以解析越严越好：任何拿不准的写法都拒绝
function tokenize(command: string): Tokenized {
  if (/[\r\n]/.test(command)) {
    return deny(
      'Newlines are not allowed; run a single-line command (for a multi-line commit message use several -m options).'
    );
  }
  if (FORBIDDEN_CHARS.test(command)) {
    return deny(
      'Control characters, invisible characters and Unicode quotes are not allowed; use ASCII quotes.'
    );
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
      const word = command.slice(i, end);
      // PowerShell 的停止解析符，其后的 %VAR% 会被展开
      if (word === '--%') return deny('The "--%" token is not allowed.');
      current.push(word);
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
  '--no-index',
  '--pathspec-from-file',
  '--orderfile',
];
// 会把任意文件读进提交信息，或打开编辑器/交互卡住命令（commit 的 -i 是 --include，不禁）
const COMMIT_FORBIDDEN_SHORT = new Set(['-F', '-t', '-e', '-p']);
const COMMIT_FORBIDDEN_LONG = ['--file', '--template', '--edit', '--interactive', '--patch'];
// add 的短选项都不带取值，合并写法（如 -Ap）里含这些字母就会打开编辑器或进入交互
const ADD_FORBIDDEN_SHORT_LETTERS = /^-[^-]*[eip]/;
const ADD_FORBIDDEN_LONG = ['--edit', '--interactive', '--patch'];
// commit 中这些选项的下一个词是提交信息，不能当作 -n 之类的开关或路径
const COMMIT_MESSAGE_OPTIONS = new Set(['-m', '--message']);

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

// git 接受长选项的无歧义前缀（如 --out=），所以前缀也要拦
function matchesLongOption(arg: string, options: string[]): boolean {
  if (!arg.startsWith('--') || arg === '--') return false;
  const name = arg.split('=')[0] as string;
  return name.length > 2 && options.some((option) => option.startsWith(name));
}

function isForbiddenGitOption(arg: string): boolean {
  return (
    GIT_FORBIDDEN_SHORT.has(arg) ||
    arg.startsWith('-O') ||
    matchesLongOption(arg, GIT_FORBIDDEN_LONG)
  );
}

function checkCommitOptions(args: string[]): RestrictedCommandResult {
  let noVerify = false;
  let hasMessage = false;
  let noEdit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--') break;
    if (COMMIT_MESSAGE_OPTIONS.has(arg)) {
      hasMessage = true;
      i++;
      continue;
    }
    if (arg.startsWith('--message=')) {
      hasMessage = true;
      continue;
    }
    // -am -n 里的 m 会把 -n 吃成提交信息，所以合并短选项一律拒绝
    if (/^-[^-]./.test(arg)) {
      return deny(
        `Combined short options or attached values ("${arg}") are not allowed in git commit; write each short option separately, e.g. -a -m "..."`
      );
    }
    if (COMMIT_FORBIDDEN_SHORT.has(arg) || matchesLongOption(arg, COMMIT_FORBIDDEN_LONG)) {
      return deny(
        `git commit option "${arg}" is not allowed (it reads a file or opens an editor/interactive prompt); pass the message with -m "...".`
      );
    }
    // 后出现的 --verify / --no-no-verify 会抵消 --no-verify
    if (arg.startsWith('--no-n') || matchesLongOption(arg, ['--verify'])) {
      return deny(`git commit option "${arg}" is not allowed; keep --no-verify in effect.`);
    }
    if (arg === '--no-verify' || arg === '-n') noVerify = true;
    if (arg === '--no-edit') noEdit = true;
  }
  if (!noVerify) {
    return deny('git commit must include --no-verify (e.g. git commit --no-verify -m "...").');
  }
  if (!hasMessage && !noEdit) {
    return deny('git commit must include -m "..." (or --no-edit) so that no editor is opened.');
  }
  return { ok: true };
}

// 越出工作区的路径会让 git diff 自动进入 no-index 模式读外部文件；`:` 开头是 pathspec 魔法
function isOutsideRepoArg(arg: string): boolean {
  return (
    /^[/\\~:]/.test(arg) ||
    /^[A-Za-z]:/.test(arg) ||
    arg.includes('\\') ||
    arg.split(/[/:]/).includes('..')
  );
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
    const result = checkCommitOptions(rest);
    if (!result.ok) return result;
  }
  if (sub === 'add') {
    const interactive = rest
      .slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length)
      .find(
        (arg) => ADD_FORBIDDEN_SHORT_LETTERS.test(arg) || matchesLongOption(arg, ADD_FORBIDDEN_LONG)
      );
    if (interactive !== undefined) {
      return deny(
        `git add option "${interactive}" is not allowed (it opens an editor or interactive prompt).`
      );
    }
  }

  // 非选项参数：`--` 之后全部算路径；commit 的 -m 取值跳过
  const operands: string[] = [];
  let afterDashes = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (afterDashes) operands.push(arg);
    else if (arg === '--') afterDashes = true;
    else if (sub === 'commit' && COMMIT_MESSAGE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith('-')) operands.push(arg);
  }

  for (const arg of operands) {
    if (isOutsideRepoArg(arg)) {
      return deny(`Argument "${arg}" must be a relative path inside the repository.`);
    }
    // HEAD:.env 这类 rev:path 也会读出文件内容，所以按 : 切开逐段判定
    if (arg.split(':').some((part) => matchesSensitiveName(part, false))) {
      return deny(`Argument "${arg}" refers to a sensitive file.`);
    }
    if (sub !== 'add' && sub !== 'rm' && sub !== 'mv') continue;
    if (sub === 'add' && arg === '.') continue;
    if (normalizeRepoPath(arg) === null) {
      return deny(`Path "${arg}" must be a relative path inside the repository.`);
    }
    if (sub === 'add' && isSensitivePath(arg)) {
      return deny(`Path "${arg}" is a sensitive file and must not be staged.`);
    }
    if (sub !== 'add' && /[[\]]/.test(arg)) {
      return deny(
        `Glob characters are not allowed in git ${sub} paths ("${arg}"); list files explicitly.`
      );
    }
    if (sub !== 'add' && isProtectedPath(arg)) {
      return deny(`Path "${arg}" is protected and cannot be removed or moved.`);
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
