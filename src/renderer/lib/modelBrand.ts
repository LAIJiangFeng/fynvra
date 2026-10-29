export type ModelBrand = 'openai' | 'anthropic' | 'xai' | 'gemini' | 'glm' | 'deepseek' | 'qwen';

// Match model families at the start of the model name, with a separator/version boundary.
// Provider names and API types are deliberately not inputs: relays can serve any brand.
const BRAND_PATTERNS: readonly [ModelBrand, RegExp][] = [
  ['openai', /^(?:(?:chatgpt|gpt)(?=$|[-_.:\s]|\d)|o[134](?=$|[-_.:\s]))/i],
  ['anthropic', /^(?:claude|opus|sonnet|haiku)(?=$|[-_.:\s]|\d)/i],
  ['xai', /^grok(?=$|[-_.:\s]|\d)/i],
  ['gemini', /^gemini(?=$|[-_.:\s]|\d)/i],
  ['glm', /^(?:chatglm|glm)(?=$|[-_.:\s]|\d)/i],
  ['deepseek', /^deepseek(?=$|[-_.:\s]|\d)/i],
  ['qwen', /^(?:qwen|qwq|qvq)(?=$|[-_.:\s]|\d)/i],
];

/** Classify only; never rewrite the original model ID displayed to the user. */
export function getModelBrand(modelId: string | undefined): ModelBrand | undefined {
  // Keep the model part of relay/provider paths; also accept common dotted namespaces
  // (including regional Bedrock IDs) and OpenAI's ft: prefix.
  const name = (modelId?.trim().split('/').at(-1) ?? '')
    .replace(
      /^(?:(?:us|eu|apac|global)\.)?(?:anthropic|openai|xai|google|zai|z-ai|zhipuai)[.:]/i,
      ''
    )
    .replace(/^ft:/i, '');
  return BRAND_PATTERNS.find(([, pattern]) => pattern.test(name))?.[0];
}
