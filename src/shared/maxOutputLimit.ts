// 端点因 max_tokens 超范围拒绝请求时，从报错文字里取出它允许的最大输出。
// Main（写回设置）与 agent worker（降低 maxTokens 后静默重试）共用；纯函数，不依赖 Node / Electron。

/** 服务端在 max_tokens 超范围报错里报的最大输出（各家措辞），按顺序匹配第一个；都要求紧挨 max_tokens */
const MAX_OUTPUT_PATTERNS: readonly RegExp[] = [
  // 智谱：max_tokens参数非法：限制数值范围[1,131072]，取区间上界
  /max_tokens[^[\]\n]{0,40}\[\s*\d+\s*,\s*(\d+)\s*\]/i,
  // Anthropic：max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens
  /max_tokens:\s*\d+\s*>\s*(\d+),?\s*which is the maximum allowed/i,
  // OpenAI：max_tokens is too large: 200000. This model supports at most 128000 completion tokens
  /max_tokens[^\n]{0,80}?supports at most (\d+) completion tokens/i,
  // max_tokens must be less than or equal to `131072`
  /max_tokens[^.\n]{0,40}?must be less than or equal to [`'"]?(\d+)/i,
];

/** 从 max_tokens 超范围的报错文字里取出服务端允许的最大输出；取不到时返回 undefined。纯函数。 */
export function parseMaxOutputLimit(message: string): number | undefined {
  for (const pattern of MAX_OUTPUT_PATTERNS) {
    const digits = pattern.exec(message)?.[1];
    if (!digits) continue;
    const limit = Number(digits);
    if (Number.isSafeInteger(limit) && limit > 0) return limit;
  }
  return undefined;
}
