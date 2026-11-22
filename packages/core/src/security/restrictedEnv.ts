/**
 * 受限会话（Telegram 值班）命令子进程可继承的环境变量。
 * 用白名单而不是黑名单：密钥变量名五花八门（*_TOKEN、*_KEY、*_SECRET、DATABASE_URL、
 * 带账号密码的代理 URL……），黑名单永远列不全，漏一个就泄露；白名单只放跑 pnpm/git
 * 必需的系统变量，新出现的变量默认不带。代理、GIT_*、NODE_OPTIONS、npm_config_* 都不放：
 * 受限命令不联网，后几类还能改变工具行为（加载任意模块、改 git 配置）。
 */
export const RESTRICTED_ENV_WHITELIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'ComSpec',
  'SystemDrive',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'PNPM_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
];

const WHITELIST_BY_UPPER = new Map(
  RESTRICTED_ENV_WHITELIST.map((name) => [name.toUpperCase(), name])
);

/** 只保留白名单里的变量；变量名不区分大小写（Windows 语义），结果使用白名单里的写法。 */
export function pickRestrictedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const canonical = WHITELIST_BY_UPPER.get(name.toUpperCase());
    if (canonical !== undefined && value !== undefined) picked[canonical] = value;
  }
  return picked;
}
