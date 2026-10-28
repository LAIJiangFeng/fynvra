/**
 * 保护底线：命令里出现这些操作时，任何审批档位都要人确认（allowSession 也不豁免）。
 *
 * 只做规则匹配，宁可多问不可漏问：引号不当作边界（`bash -c "rm -rf x"` 照样命中），
 * 程序名不要求在行首（`sudo` / `xargs` / `find -exec` 等包装后面照样命中）。
 * 返回命中的规则名，供审批条与拒绝文本展示。
 */

/** rm 的短选项（GNU / BSD）；不在其中的「短选项串」按 PowerShell 参数处理（如 `-Force`） */
const RM_SHORT_FLAGS = /^-[firdv]+$/i;
/** 递归删除的程序：POSIX rm，以及 PowerShell 里 Remove-Item 的别名 */
const RECURSIVE_DELETE = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
/** cmd 的 `/s` 递归删除 */
const CMD_DELETE = new Set(['del', 'erase', 'rd', 'rmdir']);
const PACKAGE_MANAGERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'jsr',
  'cargo',
  'poetry',
  'uv',
  'hatch',
  'flit',
  'pdm',
]);
/** 后面紧跟的是子命令而不是程序（`git rm -r --cached`、`pnpm rm -r`、`docker rm -f`） */
const SUBCOMMAND_HOSTS = new Set([
  'git',
  'docker',
  'podman',
  'kubectl',
  'gh',
  'hg',
  'svn',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
]);
/** 取一个独立参数的 git 全局选项 */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--exec-path',
]);

/** 命中的保护底线规则名；没有命中返回 undefined */
export function protectedAction(command: string): string | undefined {
  for (const words of segments(command)) {
    const hit = matchSegment(words);
    if (hit) return hit;
  }
  return undefined;
}

/** 按 shell 分隔符切成简单命令，再按空白切词并去掉两端引号；续行先接上 */
function segments(command: string): string[][] {
  return command
    .replace(/[`\\]\r?\n/g, ' ')
    .split(/[\r\n;&|(){}`]/)
    .map((segment) =>
      segment
        .split(/\s+/)
        .map((word) => word.replace(/^["']+|["']+$/g, ''))
        .filter(Boolean)
    )
    .filter((words) => words.length > 0);
}

function matchSegment(words: string[]): string | undefined {
  const subcommands = new Set<number>();
  for (let index = 0; index < words.length; index++) {
    if (subcommands.has(index)) continue;
    const program = programName(words[index] as string);
    const rest = words.slice(index + 1);
    if (program === 'git') {
      const at = gitSubcommandIndex(rest);
      if (at >= 0) subcommands.add(index + 1 + at);
      const hit = matchGit(rest, at);
      if (hit) return hit;
    } else if (SUBCOMMAND_HOSTS.has(program)) {
      subcommands.add(index + 1);
    }
    const hit = matchDelete(program, rest) ?? matchPublish(program, rest);
    if (hit) return hit;
  }
  return undefined;
}

/** `/usr/bin/git`、`C:\…\git.exe`、`Microsoft.PowerShell.Management\Remove-Item` → 小写的程序名 */
function programName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function gitSubcommandIndex(rest: string[]): number {
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index] as string;
    if (!word.startsWith('-')) return index;
    if (GIT_OPTIONS_WITH_VALUE.has(word)) index++;
  }
  return -1;
}

function matchGit(rest: string[], at: number): string | undefined {
  const subcommand = rest[at]?.toLowerCase();
  if (subcommand === 'push') return 'git push';
  if (subcommand === 'reset' && rest.slice(at + 1).some((word) => word === '--hard')) {
    return 'git reset --hard';
  }
  return undefined;
}

function matchDelete(program: string, rest: string[]): string | undefined {
  if (CMD_DELETE.has(program) && rest.some(isCmdRecursiveSwitch)) return 'del /s';
  if (!RECURSIVE_DELETE.has(program) || !rest.some(isRecursiveFlag)) return undefined;
  return program === 'rm' ? 'rm -rf' : 'Remove-Item -Recurse';
}

function matchPublish(program: string, rest: string[]): string | undefined {
  if (!PACKAGE_MANAGERS.has(program)) return undefined;
  return rest.some((word) => word.toLowerCase() === 'publish') ? `${program} publish` : undefined;
}

/** `-r` / `-rf` / `-Rf` / `--recursive`（可缩写），或 PowerShell 的 `-Recurse`（可缩写，可带 `:$true`） */
function isRecursiveFlag(word: string): boolean {
  if (RM_SHORT_FLAGS.test(word)) return /r/i.test(word);
  const lower = word.toLowerCase();
  if (lower.startsWith('--')) return lower.length >= 3 && '--recursive'.startsWith(lower);
  const name = lower.split(':')[0] as string;
  return name.length >= 2 && '-recurse'.startsWith(name);
}

/** cmd 的开关可以连写：`/s`、`/S`、`/q/s` */
function isCmdRecursiveSwitch(word: string): boolean {
  return word.startsWith('/') && word.toLowerCase().split('/').includes('s');
}
