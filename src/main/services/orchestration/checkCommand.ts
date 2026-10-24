/**
 * run_checks 的命令白名单。run_checks 是主 agent 唯一能执行命令的入口，命令经 shell 执行
 * （要支持 `pnpm typecheck && pnpm lint`），所以只放行「白名单程序 + 不含 shell 元字符」的命令：
 * 用 `&&`、`;`、`|` 串起来的每一段都必须以白名单里的程序开头，其余 shell 元字符一律拒绝。
 * 这只是粗粒度护栏而不是沙箱：node / npx / make 本身就能执行任意代码。
 */
export interface CheckCommandPolicy {
  /** 允许的程序：每一段的第一个词必须与其中之一完全相同（不接受路径、大小写变体）。 */
  programs: readonly string[];
  /** 程序 → 只允许的子命令（该段第二个词）；没列出的程序不限制子命令。 */
  allowedSubcommands?: Readonly<Record<string, readonly string[]>>;
  /** 程序 → 禁止出现的参数：任一参数等于它即拒绝；以 `-` 开头的项也拒绝 `<项>=…`。 */
  deniedArguments?: Readonly<Record<string, readonly string[]>>;
}

/** {@link checkCommand} 的结果；通过时 `command` 是去掉首尾空白后的命令。 */
export type CheckCommandVerdict = { ok: true; command: string } | { ok: false; error: string };

const PACKAGE_REGISTRY_COMMANDS = [
  'publish',
  'unpublish',
  'deprecate',
  'dist-tag',
  'owner',
  'access',
  'adduser',
  'login',
  'logout',
  'token',
];

/**
 * 默认策略：程序列表按任务书；另外 git 只放行只读子命令（主 agent 不能借 run_checks 提交、推送或改分支），
 * 包管理器不放行发布 / 登录类子命令（对外且不可撤销）。
 */
export const DEFAULT_CHECK_COMMAND_POLICY: CheckCommandPolicy = {
  programs: [
    'pnpm',
    'npm',
    'yarn',
    'bun',
    'node',
    'npx',
    'git',
    'cargo',
    'go',
    'python',
    'pytest',
    'make',
  ],
  allowedSubcommands: {
    git: [
      'status',
      'diff',
      'log',
      'show',
      'ls-files',
      'rev-parse',
      'rev-list',
      'merge-base',
      'blame',
      'describe',
      'cat-file',
      'ls-tree',
      'shortlog',
    ],
  },
  deniedArguments: {
    git: ['--output', '--ext-diff', '--textconv'],
    npm: PACKAGE_REGISTRY_COMMANDS,
    pnpm: PACKAGE_REGISTRY_COMMANDS,
    yarn: ['publish', 'npm', 'login', 'logout'],
    bun: ['publish'],
    cargo: ['publish', 'yank', 'login', 'logout', 'owner'],
  },
};

/** 命令长度上限（字符）。 */
export const MAX_CHECK_COMMAND_LENGTH = 4000;

// 段内允许的字符：字母、数字、空格和不触发 shell 语义的标点；引号只会让内容更「字面」，放行
const SAFE_CHAR = /^[\p{L}\p{N}\p{M} _\-./\\:=@,+~"']$/u;
const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd']);

function reject(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** 按 `&&`、`;`、`|` 切段；遇到其他 shell 元字符或单个 `&` 返回错误。 */
function splitSegments(
  command: string
): { ok: true; segments: string[] } | { ok: false; error: string } {
  const chars = [...command];
  const segments: string[] = [];
  let current = '';
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] as string;
    if (char === ';' || char === '|') {
      segments.push(current);
      current = '';
    } else if (char === '&') {
      if (chars[index + 1] !== '&') {
        return reject('a single "&" (background job) is not allowed; chain commands with "&&"');
      }
      segments.push(current);
      current = '';
      index++;
    } else if (SAFE_CHAR.test(char)) {
      current += char;
    } else {
      return reject(
        `shell metacharacter ${JSON.stringify(char)} is not allowed in run_checks commands`
      );
    }
  }
  segments.push(current);
  return { ok: true, segments };
}

function checkSegment(segment: string, policy: CheckCommandPolicy): string | undefined {
  const words = segment.trim().split(/ +/);
  const [program = '', ...args] = words;
  if (program === '') {
    return 'empty command between separators ("||" and ";;" are not supported)';
  }
  if (!policy.programs.includes(program)) {
    const hint = DIRECTORY_COMMANDS.has(program)
      ? '; commands run in the worktree root, use the directory option of the tool instead (e.g. pnpm -C <dir> test, make -C <dir>)'
      : '';
    return `${JSON.stringify(program)} is not an allowed program in run_checks (allowed: ${policy.programs.join(', ')})${hint}`;
  }

  const subcommands = policy.allowedSubcommands?.[program];
  if (subcommands !== undefined) {
    const [subcommand] = args;
    if (subcommand === undefined) {
      return `${program} needs a subcommand (allowed: ${subcommands.join(', ')})`;
    }
    if (!subcommands.includes(subcommand)) {
      return `${program} ${subcommand} is not allowed in run_checks (allowed ${program} subcommands: ${subcommands.join(', ')})`;
    }
  }

  for (const denied of policy.deniedArguments?.[program] ?? []) {
    const isOption = denied.startsWith('-');
    const hit = args.find((arg) => arg === denied || (isOption && arg.startsWith(`${denied}=`)));
    if (hit !== undefined) {
      return isOption
        ? `${JSON.stringify(hit)} is not allowed for ${program} in run_checks`
        : `${program} ${denied} is not allowed in run_checks`;
    }
  }
  return undefined;
}

/** 校验 run_checks 命令；纯函数，不执行任何东西。 */
export function checkCommand(
  raw: string,
  policy: CheckCommandPolicy = DEFAULT_CHECK_COMMAND_POLICY
): CheckCommandVerdict {
  if (typeof raw !== 'string') return reject('command must be a string');
  // 先于 trim 检查：换行能在 shell 里另起一条命令
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return reject(`control character U+${hex} is not allowed in run_checks commands`);
    }
  }
  const command = raw.trim();
  if (command === '') return reject('command is empty');
  if (command.length > MAX_CHECK_COMMAND_LENGTH) {
    return reject(`command is longer than ${MAX_CHECK_COMMAND_LENGTH} characters`);
  }

  const split = splitSegments(command);
  if (!split.ok) return split;
  for (const segment of split.segments) {
    const error = checkSegment(segment, policy);
    if (error !== undefined) return reject(error);
  }
  return { ok: true, command };
}
