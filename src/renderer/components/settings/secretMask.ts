// 界面上的命令 / URL 摘要打码（纯函数，在 node 下测试）。只影响显示：存储、IPC 契约不变，编辑弹窗里仍是原值。

const HEAD = 3;
const TAIL = 2;
/** 短于这个长度的值整个遮住：留前 3 后 2 会露出大半 */
const MIN_PARTIAL_LENGTH = 8;
/** 按前缀认出的 token 至少这么长 */
const MIN_TOKEN_LENGTH = 20;

/** 之后的一个参数（或 `--flag=值` 的值）是密钥 */
const SECRET_FLAGS = new Set(['--api-key', '--token', '--key', '-k', '--password']);
/** 键名含这些词的 `name=value`、URL query、请求头的值打码 */
const SECRET_NAME = /key|token|secret|password|auth/i;
/** Bearer / Basic 之后是凭据；也认 `Authorization:Bearer` 这样连写的 */
const AUTH_SCHEME = /^(?:bearer|basic)$/i;
const ENDS_WITH_AUTH_SCHEME = /(?:^|[:=])(?:bearer|basic)$/i;
const HEADER_NAME = /^[A-Za-z][\w-]*$/;
/** 单个参数写成 `name=value` 或 `name:value`（`--api-key=…`、`GITHUB_TOKEN=…`、`X-API-Key:…`） */
const ASSIGNMENT = /^(-{0,2}[A-Za-z_][\w.-]*)([=:])(.+)$/;
const SECRET_QUERY = /([?&#][^=&#\s]*(?:key|token|secret|password|auth)[^=&#\s]*=)([^&#\s]+)/gi;

/**
 * 形状固定的密钥前缀（区分大小写，免得误伤 `HF_HUB_…` 这类环境变量名）：OpenAI / Anthropic / 各家中转、
 * Stripe、Context7、GitHub、GitLab、Slack、Tavily、Google、Hugging Face、Groq、Replicate、Figma、Notion、
 * Linear、Supabase、AWS；另认三段式 JWT。
 */
const TOKEN_PREFIXES = [
  'sk-',
  'sk_',
  'ctx7sk-',
  'gh[pousr]_',
  'github_pat_',
  'glpat-',
  'xox[abprs]-',
  'tvly-',
  'AIza',
  'hf_',
  'gsk_',
  'r8_',
  'figd_',
  'ntn_',
  'lin_api_',
  'sbp_',
  'AKIA',
];
const PREFIXED_TOKEN = new RegExp(
  `(?<![\\w-])(?:(?:${TOKEN_PREFIXES.join('|')})[\\w-]+|eyJ[\\w-]+(?:\\.[\\w-]+){1,2})`,
  'g'
);

const SHORT_NUMBER = /^\d{1,6}$/;
const PATH = /^(?:[A-Za-z]:[\\/]|~?[\\/]|\.{1,2}[\\/])/;
/** `${VAR}`、`$VAR`、`%VAR%`、OpenCode 的 `{env:VAR}` / `{file:…}`：引用不是密钥本身，留着能看出用的哪个变量 */
const VARIABLE = /^(?:\$\{[^}]+\}|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%|\{(?:env|file):[^}]+\})$/;
const URL_LIKE = /^[A-Za-z][\w+.-]*:\/\//;

/**
 * 把文本里的密钥打码为前 3 + `…` + 后 2（短于 8 个字符的整个换成 `…`）：
 * - 命令参数 `--api-key` / `--token` / `--key` / `-k` / `--password` 之后的一个参数，及其 `--flag=值` 写法；
 *   键名含 key / token / secret / password / auth 的 `name=value`；
 * - URL query（及 `#` 片段）里键名含这些词的值；
 * - 长度 ≥ 20、带 `sk-`、`ctx7sk-` 等已知前缀的 token，出现在哪都算；
 * - 顺带：`Authorization: Bearer <凭据>` 这类请求头。
 * 短数字、路径、变量引用、URL 不当作密钥值；已经打过码的不再打。
 */
export function maskSecrets(text: string): string {
  // 上一个参数是密钥开关（或请求头名、Bearer），这一个是它的值
  let pending = false;
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (part.trim() === '') return part;
      if (pending) {
        pending = false;
        if (AUTH_SCHEME.test(part)) {
          pending = true;
          return part;
        }
        // 下一个开关、路径之类不是值：照普通参数处理
        if (!part.startsWith('-') && isSecretValue(part)) return maskValue(part);
      }
      if (takesSecretValue(part)) {
        pending = true;
        return part;
      }
      return maskToken(part);
    })
    .join('');
}

function takesSecretValue(part: string): boolean {
  if (SECRET_FLAGS.has(part) || ENDS_WITH_AUTH_SCHEME.test(part)) return true;
  // `Authorization:`、`X-API-Key:` 这样的请求头名，值在下一个参数
  const name = part.endsWith(':') ? part.slice(0, -1) : '';
  return HEADER_NAME.test(name) && SECRET_NAME.test(name);
}

/** 单个参数内部：`name=value` / `name:value`、URL query、带前缀的长 token */
function maskToken(part: string): string {
  const assignment = ASSIGNMENT.exec(part);
  if (assignment) {
    const [, name = '', separator = '', value = ''] = assignment;
    if ((SECRET_FLAGS.has(name) || SECRET_NAME.test(name)) && isSecretValue(value)) {
      return `${name}${separator}${maskValue(value)}`;
    }
  }
  return part
    .replace(SECRET_QUERY, (match, head: string, value: string) =>
      isSecretValue(value) ? `${head}${maskValue(value)}` : match
    )
    .replace(PREFIXED_TOKEN, (token) =>
      token.length >= MIN_TOKEN_LENGTH ? maskValue(token) : token
    );
}

function isSecretValue(value: string): boolean {
  return (
    value !== '' &&
    !value.includes('…') &&
    !SHORT_NUMBER.test(value) &&
    !PATH.test(value) &&
    !VARIABLE.test(value) &&
    !URL_LIKE.test(value)
  );
}

function maskValue(value: string): string {
  return value.length < MIN_PARTIAL_LENGTH ? '…' : `${value.slice(0, HEAD)}…${value.slice(-TAIL)}`;
}
