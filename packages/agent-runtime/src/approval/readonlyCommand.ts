import { checkGitArgs } from '../tools/readonlyTools';

/**
 * 计划模式下的只读命令判定（纯函数，审批门用）：判定为只读的 bash / powershell 命令按原审批档位处理，
 * 其他命令不论档位都要人确认。
 *
 * 判定是保守的：拿不准就算「非只读」，代价只是多问用户一次。bash 工具在 Windows 上也可能由 PowerShell 执行，
 * 所以同一条命令按 bash 和 PowerShell 两种读法各拆一遍，两种读法下都只读才算只读：
 * - 在引号外按 `;`、`&&`、`||`、`|` 和换行拆段，每段的第一个词都必须在白名单里（不区分大小写、不带路径），
 *   能写文件或运行别的程序的命令再看参数（如 find 的 `-delete` / `-exec`，git 只认部分子命令）；
 * - 一律算非只读：输出重定向（`2>&1` 这类复制和 `>/dev/null`、`2>$null` 这类丢弃除外）、`<`（含 `<(` 与 here-doc）、
 *   命令替换 `$(` 与反引号、引号外的 `{` `}` `(` `)` `@` `#` 和单个 `&`、变量展开 `$`、
 *   `Invoke-Expression` / `iex` / `Start-Process` 等；
 * - 两种 shell 拆法可能不同的写法也算非只读：反斜杠后跟空白或特殊字符、双引号里的 `\"` 与 `""`、续行、
 *   PowerShell 当作引号 / 破折号 / 空白的 Unicode 字符、控制字符。
 */
export function isReadOnlyCommand(command: string): boolean {
  const segments = splitCommand(command);
  if (!segments || segments.length === 0) return false;
  return segments.every(
    (segment) => isReadOnlySegment(segment.bash) && isReadOnlySegment(segment.powershell)
  );
}

// ---------------------------------------------------------------------------
// 白名单

type ArgsCheck = (args: readonly string[]) => boolean;

const anyArgs: ArgsCheck = () => true;

/** 参数不影响只读性的命令；PowerShell 的 ls / dir / cat / type 别名同样适用 */
const PLAIN_COMMANDS = [
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'more',
  'wc',
  'grep',
  'stat',
  'du',
  'df',
  'which',
  'whereis',
  'type',
  'echo',
  'cut',
  'diff',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'whoami',
  'uname',
  'printenv',
];

/** PowerShell 的只读 cmdlet 与别名（命令名不区分大小写，这里都写小写） */
const POWERSHELL_COMMANDS = [
  'get-childitem',
  'gci',
  'get-content',
  'gc',
  'get-item',
  'get-location',
  'select-string',
  'sls',
  'test-path',
  'resolve-path',
  'measure-object',
  'sort-object',
  'select-object',
  'format-table',
  'format-list',
  'get-command',
  'get-date',
];

/** find 的这些动作会删文件、执行命令或写文件（-execdir、-okdir、-fprint0、-fprintf 按前缀命中） */
const FIND_WRITE_ACTIONS = ['-delete', '-exec', '-ok', '-fprint', '-fls'];

/** date 取值的长选项：值在下一个参数里 */
const DATE_VALUE_OPTIONS = new Set(['--date', '--file', '--reference']);

/** 只读白名单：小写的命令名 → 参数检查 */
const READONLY_COMMANDS = new Map<string, ArgsCheck>([
  ...[...PLAIN_COMMANDS, ...POWERSHELL_COMMANDS].map((name): [string, ArgsCheck] => [
    name,
    anyArgs,
  ]),
  // 不带任何选项：-o / -O / --log-file 写日志文件，+cmd 在启动时执行 less 命令
  ['less', (args) => !args.some((arg) => arg.startsWith('-') || arg.startsWith('+'))],
  // --pre / --hostname-bin 运行外部程序
  [
    'rg',
    (args) =>
      !args.some((arg) => isLongOption(arg, '--pre') || isLongOption(arg, '--hostname-bin')),
  ],
  [
    'find',
    (args) =>
      !args.some((arg) => {
        const lower = arg.toLowerCase();
        return FIND_WRITE_ACTIONS.some((action) => lower.startsWith(action));
      }),
  ],
  // -x / --exec / -X / --exec-batch 对结果执行命令（短选项可以连写）
  [
    'fd',
    (args) =>
      !args.some(
        (arg) =>
          (isShortOptions(arg) && /x/i.test(arg)) ||
          isLongOption(arg, '--exec') ||
          isLongOption(arg, '--exec-batch')
      ),
  ],
  // -o 写输出文件，-R（配合 -H）在每个目录写 00Tree.html
  ['tree', (args) => !args.some((arg) => isShortOptions(arg) && /[oR]/.test(arg))],
  // -C / --compile 写 .mgc 文件
  [
    'file',
    (args) =>
      !args.some(
        (arg) => (isShortOptions(arg) && arg.includes('C')) || isLongOption(arg, '--compile')
      ),
  ],
  // bash 的 printf -v 给 shell 变量（包括 PATH）赋值
  ['printf', (args) => !args.some((arg) => arg.startsWith('-v'))],
  // -o / --output 写文件，--compress-program 运行外部程序
  [
    'sort',
    (args) =>
      !args.some(
        (arg) =>
          (isShortOptions(arg) && arg.includes('o')) ||
          isLongOption(arg, '--output') ||
          isLongOption(arg, '--compress-program')
      ),
  ],
  ['uniq', uniqArgs],
  ['date', dateArgs],
  // 带参数时会运行别的程序（env NAME=value cmd）
  ['env', (args) => args.length === 0],
  ['git', gitArgs],
]);

/**
 * git 的全局选项只认这几个：`-c` 能改配置（pager、fsmonitor 等配置会执行命令），
 * `-C` / `--git-dir` / `--work-tree` 会读别的仓库及其配置
 */
const GIT_GLOBAL_OPTIONS = new Set(['--no-pager', '-P', '--no-optional-locks']);

/** 只读的 git 子命令 → 子命令之后的参数检查 */
const GIT_SUBCOMMANDS = new Map<string, ArgsCheck>([
  ...['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse', 'describe'].map(
    (name): [string, ArgsCheck] => [name, gitCommonArgs]
  ),
  // -O / --open-files-in-pager 用命中的文件启动 pager 程序（短选项可以连写）
  [
    'grep',
    (args) =>
      gitCommonArgs(args) &&
      !args.some(
        (arg) =>
          (isShortOptions(arg) && arg.includes('O')) || isLongOption(arg, '--open-files-in-pager')
      ),
  ],
  // 只列出远端
  ['remote', (args) => args.every((arg) => arg === '-v' || arg === '--verbose')],
  // 只列出分支：与 git_readonly 同一套检查（不能新建，不能带 -d / -D / -m / -M / -c / -C 等）
  ['branch', (args) => checkGitArgs(['branch', ...args]).ok],
]);

/**
 * 在任何位置出现都算非只读的词（不区分大小写）：PowerShell 执行代码 / 启动进程的命令，
 * 以及 `--%`（PowerShell 把之后的文本原样交给程序，由程序自己拆分）
 */
const REFUSED_WORDS = new Set([
  'invoke-expression',
  'iex',
  'start-process',
  'saps',
  'invoke-command',
  'icm',
  'invoke-item',
  'start-job',
  'add-type',
  '--%',
]);

function isReadOnlySegment(words: readonly string[]): boolean {
  const [head, ...args] = words;
  if (head === undefined || words.some(isRefusedWord)) return false;
  const check = READONLY_COMMANDS.get(head.toLowerCase());
  return check?.(args) === true;
}

/**
 * 不论哪个命令都不放行的词。含 `"`，或含空白又以 `\` 结尾的参数：Windows PowerShell 把参数拼成命令行交给
 * 外部程序时不转义这些字符，程序重新拆出来的参数会和这里看到的不同。
 */
function isRefusedWord(word: string): boolean {
  return (
    REFUSED_WORDS.has(word.toLowerCase()) ||
    word.includes('"') ||
    (/\s/.test(word) && word.endsWith('\\'))
  );
}

/** 单横线的短选项（可以连写，如 `-la`）；单独的 `-`（标准输入）不算 */
function isShortOptions(arg: string): boolean {
  return arg.length > 1 && arg.startsWith('-') && !arg.startsWith('--');
}

/**
 * `arg` 是长选项 `option`（可带 `=value`）或它的缩写：GNU getopt 与 git 都接受无歧义的前缀，
 * 这里不管有没有歧义一律算命中。不区分大小写。
 */
function isLongOption(arg: string, option: string): boolean {
  if (!arg.startsWith('--')) return false;
  const name = (arg.split('=', 1)[0] ?? '').toLowerCase();
  return name.length > 2 && option.startsWith(name);
}

/** uniq 的第二个操作数是输出文件：最多一个操作数，而且不能带通配符（可能展开成几个文件） */
function uniqArgs(args: readonly string[]): boolean {
  const operands = args.filter((arg) => arg === '-' || !arg.startsWith('-'));
  return operands.length <= 1 && !operands.some((arg) => /[*?[]/.test(arg));
}

/** date：`-s` / `--set`，以及不以 `+` 开头的操作数（`MMDDhhmm…`）会设置系统时间 */
function dateArgs(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? '';
    if (arg.startsWith('--')) {
      if (isLongOption(arg, '--set')) return false;
      if (DATE_VALUE_OPTIONS.has(arg)) at++;
      continue;
    }
    if (isShortOptions(arg)) {
      // 短选项可以连写；-d / -f / -r 的值在本参数余下部分或下一个参数里，-I 的值只能紧跟
      for (let index = 1; index < arg.length; index++) {
        const flag = arg[index];
        if (flag === 's') return false;
        if (flag === 'd' || flag === 'f' || flag === 'r') {
          if (index === arg.length - 1) at++;
          break;
        }
        if (flag === 'I') break;
      }
      continue;
    }
    if (!arg.startsWith('+')) return false;
  }
  return true;
}

function gitArgs(args: readonly string[]): boolean {
  let at = 0;
  for (; at < args.length && args[at]?.startsWith('-'); at++) {
    if (!GIT_GLOBAL_OPTIONS.has(args[at] ?? '')) return false;
  }
  const check = GIT_SUBCOMMANDS.get(args[at] ?? '');
  return check?.(args.slice(at + 1)) === true;
}

/** `--output` 把结果写进文件，`--ext-diff` 运行外部 diff 程序 */
function gitCommonArgs(args: readonly string[]): boolean {
  return !args.some((arg) => isLongOption(arg, '--output') || isLongOption(arg, '--ext-diff'));
}

// ---------------------------------------------------------------------------
// 拆分

/** 一段简单命令的两种读法（词已去掉引号） */
interface Segment {
  /** bash：引号外的反斜杠转义下一个字符 */
  bash: string[];
  /** PowerShell：反斜杠是普通字符；引号外的逗号分隔数组元素，传给外部程序时是几个参数 */
  powershell: string[];
}

/** 出现即算非只读：控制字符（制表、换行、回车除外） */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截控制字符
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * 出现即算非只读：PowerShell 当作破折号（U+2013–U+2015）或引号（U+2018–U+201E）的字符，
 * 以及空格、制表、换行之外的空白（PowerShell 按它分词，bash 不会）
 */
const POWERSHELL_SPECIAL_CHARS = /[\u2013-\u2015\u2018-\u201e]|[^\S \t\r\n]/u;

/**
 * 引号外出现即算非只读：`<`（输入重定向、here-doc、`<(`）、`(` `)`（子 shell、PowerShell 表达式）、
 * `{` `}`（脚本块、花括号展开）、反引号（命令替换 / PowerShell 转义）、`$`（变量与 `$(`）、`#`（注释）、
 * `@`（splatting、数组与 here-string）
 */
const UNQUOTED_REFUSED = new Set(['<', '(', ')', '{', '}', '`', '$', '#', '@']);

/** 反斜杠后跟这些字符时，bash（转义）和 PowerShell（反斜杠是普通字符）拆出来的词或段不同 */
const AFTER_BACKSLASH_REFUSED = new Set([
  ' ',
  '\t',
  '\r',
  '\n',
  ';',
  '|',
  '&',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  "'",
  '"',
  '`',
  '$',
  '#',
  '@',
  ',',
]);

/** 按 shell 语法拆成简单命令；遇到算作非只读的写法返回 undefined */
function splitCommand(command: string): Segment[] | undefined {
  if (CONTROL_CHARS.test(command) || POWERSHELL_SPECIAL_CHARS.test(command)) return undefined;
  const segments: Segment[] = [];
  let bash: string[] = [];
  let powershell: string[] = [];
  // 当前词；undefined 表示不在词里。两种读法只在逗号处断词不同
  let bashWord: string | undefined;
  let powershellWord: string | undefined;
  // 当前词带引号或转义：这样的数字不是重定向的 fd
  let quoted = false;

  const append = (bashText: string, powershellText: string = bashText) => {
    bashWord = (bashWord ?? '') + bashText;
    powershellWord = (powershellWord ?? '') + powershellText;
  };
  const endWord = () => {
    if (bashWord !== undefined) bash.push(bashWord);
    if (powershellWord !== undefined) powershell.push(powershellWord);
    bashWord = undefined;
    powershellWord = undefined;
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    if (bash.length > 0 || powershell.length > 0) segments.push({ bash, powershell });
    bash = [];
    powershell = [];
  };

  let at = 0;
  while (at < command.length) {
    const char = command[at] ?? '';
    switch (char) {
      case ' ':
      case '\t':
        endWord();
        at++;
        break;
      case '\r':
      case '\n':
      case ';':
        endSegment();
        at++;
        break;
      case '|':
        endSegment();
        at += command[at + 1] === '|' ? 2 : 1;
        break;
      case '&':
        // && 分段；单个 & 是 bash 的后台执行、PowerShell 的调用运算符
        if (command[at + 1] !== '&') return undefined;
        endSegment();
        at += 2;
        break;
      case '>': {
        // 紧挨着 > 的未加引号的单个数字是流编号（2>、2>>），不是参数；PowerShell 只认 1–6
        if (!quoted && bashWord !== undefined && /^[1-6]$/.test(bashWord)) {
          bashWord = undefined;
          powershellWord = undefined;
        }
        endWord();
        const next = skipRedirection(command, at);
        if (next === undefined) return undefined;
        at = next;
        break;
      }
      case "'": {
        // 单引号里两种 shell 都是字面量（PowerShell 的 '' 转义按两个相邻的串处理，断词相同）
        const end = command.indexOf("'", at + 1);
        if (end < 0) return undefined;
        append(command.slice(at + 1, end));
        quoted = true;
        at = end + 1;
        break;
      }
      case '"': {
        const text = readDoubleQuoted(command, at);
        if (!text) return undefined;
        append(text.bash, text.powershell);
        quoted = true;
        at = text.end;
        break;
      }
      case '\\': {
        const next = command[at + 1];
        if (next === undefined) {
          append('\\');
          at++;
          break;
        }
        if (AFTER_BACKSLASH_REFUSED.has(next)) return undefined;
        append(next, `\\${next}`);
        quoted = true;
        at += 2;
        break;
      }
      case ',':
        // PowerShell 的数组元素分隔符；bash 里是普通字符
        bashWord = `${bashWord ?? ''},`;
        if (powershellWord !== undefined) powershell.push(powershellWord);
        powershellWord = undefined;
        at++;
        break;
      default:
        if (UNQUOTED_REFUSED.has(char)) return undefined;
        append(char);
        at++;
    }
  }
  endSegment();
  return segments;
}

/**
 * 双引号串，`at` 指向开头的 `"`。两种 shell 在双引号里都展开 `$`，反引号是 bash 的命令替换、PowerShell 的转义；
 * `\"` 在 bash 里是转义的引号、在 PowerShell 里结束字符串，`""` 在 PowerShell 里是转义的引号，`\` 加换行是 bash 的续行：
 * 这些都算非只读，返回 undefined。
 */
function readDoubleQuoted(
  command: string,
  at: number
): { bash: string; powershell: string; end: number } | undefined {
  let bash = '';
  let powershell = '';
  for (let index = at + 1; index < command.length; index++) {
    const char = command[index] ?? '';
    if (char === '"') {
      return command[index + 1] === '"' ? undefined : { bash, powershell, end: index + 1 };
    }
    if (char === '$' || char === '`') return undefined;
    if (char === '\\') {
      const next = command[index + 1];
      if (next === '"' || next === '\r' || next === '\n') return undefined;
      if (next === '\\') {
        bash += '\\';
        powershell += '\\\\';
        index++;
        continue;
      }
    }
    bash += char;
    powershell += char;
  }
  return undefined;
}

/**
 * `>` / `>>` 重定向（`at` 指向第一个 `>`）：只放行 fd 复制（`2>&1`、`>&2`）和丢弃输出（`>/dev/null`、`2>$null`，
 * 目标前可以有空格）。返回重定向之后的位置；写文件、`>&file`、`>|`、`>(…)` 等返回 undefined。
 */
function skipRedirection(command: string, at: number): number | undefined {
  let next = command[at + 1] === '>' ? at + 2 : at + 1;
  if (command[next] === '&') {
    if (next !== at + 1) return undefined;
    const fd = /^\d+/.exec(command.slice(next + 1))?.[0];
    if (!fd) return undefined;
    next += 1 + fd.length;
    const after = command[next];
    return after === undefined || /[\s;|&]/.test(after) ? next : undefined;
  }
  while (command[next] === ' ' || command[next] === '\t') next++;
  const target = /^[^\s;|&]*/.exec(command.slice(next))?.[0] ?? '';
  return target === '/dev/null' || target.toLowerCase() === '$null'
    ? next + target.length
    : undefined;
}
