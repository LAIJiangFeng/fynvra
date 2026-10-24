// 「列模型」接口的返回样本：照官方文档与常见中转（new-api / one-api 一类）的实际形态写，测试用。

/** Anthropic 官方 `GET /v1/models` */
export const ANTHROPIC_MODELS = {
  data: [
    {
      type: 'model',
      id: 'claude-sonnet-5-5',
      display_name: 'Claude Sonnet 5.5',
      created_at: '2026-06-02T00:00:00Z',
    },
    {
      type: 'model',
      id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      created_at: '2026-06-02T00:00:00Z',
    },
    {
      type: 'model',
      id: 'claude-haiku-4-5-20251001',
      display_name: 'Claude Haiku 4.5',
      created_at: '2025-10-15T00:00:00Z',
    },
  ],
  has_more: false,
  first_id: 'claude-sonnet-5-5',
  last_id: 'claude-haiku-4-5-20251001',
};

/** 只实现了 OpenAI 形态的中转：没有显示名，常有重复条目 */
export const OPENAI_RELAY_MODELS = {
  object: 'list',
  data: [
    { id: 'gpt-6-sol', object: 'model', created: 1_767_225_600, owned_by: 'openai' },
    { id: 'claude-opus-5-5', object: 'model', created: 1_767_225_600, owned_by: 'anthropic' },
    { id: 'deepseek-chat', object: 'model', created: 1_735_689_600, owned_by: 'deepseek' },
    { id: 'gpt-6-sol', object: 'model', created: 1_767_225_600, owned_by: 'openai' },
  ],
  success: true,
};

/** Google `GET /v1beta/models`：嵌入、图像模型不支持 generateContent */
export const GOOGLE_MODELS = {
  models: [
    {
      name: 'models/gemini-4-argon',
      version: '4.0',
      displayName: 'Gemini 4 Argon',
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 32_768,
      supportedGenerationMethods: ['generateContent', 'countTokens', 'createCachedContent'],
      thinking: true,
    },
    {
      name: 'models/gemini-flash-latest',
      displayName: 'Gemini Flash Latest',
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/text-embedding-004',
      displayName: 'Text Embedding 004',
      inputTokenLimit: 2048,
      outputTokenLimit: 1,
      supportedGenerationMethods: ['embedContent'],
    },
    {
      name: 'models/imagen-4.0-generate-001',
      displayName: 'Imagen 4',
      inputTokenLimit: 480,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ['predict'],
    },
  ],
};

/** 部分中转仿 Google 接口时不写 supportedGenerationMethods */
export const GOOGLE_RELAY_MODELS = {
  models: [{ name: 'models/gemini-pro-latest', displayName: 'Gemini Pro Latest' }],
  nextPageToken: 'page-2',
};

/** 中转的登录页 / 首页：200 但不是 JSON */
export const HTML_PAGE =
  '<!doctype html><html><head><title>Relay</title></head><body></body></html>';
