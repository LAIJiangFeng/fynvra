const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 10;
// 9 位 base36 毫秒时间戳可用到公元 5188 年，定长保证字典序 = 时间序。
const TIME_LENGTH = 9;
const PREFIX_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * 生成实体 id：`<prefix>_<9 位 base36 时间戳><10 位随机>`，如 `task_0mh4x2k1c7q2v9z0d3f`。
 * 只含 `[a-z0-9_]`，可直接用作文件名 / URL 片段；不同毫秒生成的 id 按字典序递增。
 * 随机部分来自全局 Web Crypto（Node、Electron 各进程、浏览器都有），不依赖 Node 模块。
 *
 * @param prefix - 实体种类，小写字母开头的字母数字串，如 `'run'`、`'task'`、`'dispatch'`、`'msg'`。
 * @throws TypeError 当 `prefix` 不符合上述格式（编程错误）。
 */
export function newId(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      `newId: prefix must match ${PREFIX_PATTERN}, got ${JSON.stringify(prefix)}`
    );
  }
  const bytes = new Uint8Array(RANDOM_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let random = '';
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${Date.now().toString(36).padStart(TIME_LENGTH, '0')}${random}`;
}
