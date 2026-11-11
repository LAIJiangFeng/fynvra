import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core';

// 代码块高亮：shiki core + JavaScript 正则引擎（CSP 不允许 WASM，oniguruma 用不了），
// 语法与主题都按需懒加载，只打包下面这些语言。

type LanguageModule = Promise<{ default: LanguageRegistration[] }>;

const LANGUAGES: Record<string, () => LanguageModule> = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  console: 'bash',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  docker: 'dockerfile',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsonc: 'json',
  json5: 'json',
  kt: 'kotlin',
  md: 'markdown',
  ps: 'powershell',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  yml: 'yaml',
  patch: 'diff',
  svg: 'xml',
};

export const CODE_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/** 按 key 总字符数限量的 LRU：命中时挪到最新，超额时从最久没用的开始淘汰 */
export class CharLru<V> {
  private readonly entries = new Map<string, V>();
  private total = 0;

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (key.length > this.limit) return;
    if (this.entries.delete(key)) this.total -= key.length;
    this.entries.set(key, value);
    this.total += key.length;
    for (const oldest of this.entries.keys()) {
      if (this.total <= this.limit) break;
      this.entries.delete(oldest);
      this.total -= oldest.length;
    }
  }
}

/** 已高亮结果的缓存：虚拟列表滚回来重新挂载时直接复用，不闪一下纯文本。聊天、工具输出、文件预览共用，按字符总量限量 */
const cache = new CharLru<ThemedToken[][]>(2_000_000);
/** 超过这个长度不高亮：JS 正则引擎逐行匹配，太长的块会卡住界面 */
const MAX_HIGHLIGHT_CHARS = 20_000;
let highlighter: Promise<HighlighterCore> | null = null;

export function resolveLanguage(lang: string): string | null {
  const id = lang.trim().toLowerCase();
  const resolved = ALIASES[id] ?? id;
  return resolved in LANGUAGES ? resolved : null;
}

function cacheKey(code: string, language: string): string {
  return `${language}\u0000${code}`;
}

/** 同步取缓存；没有时返回 null */
export function peekHighlighted(code: string, lang: string): ThemedToken[][] | null {
  const language = resolveLanguage(lang);
  return language ? (cache.get(cacheKey(code, language)) ?? null) : null;
}

function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighter;
}

/** 等到浏览器空闲：同步分词放这里跑，滚动时不抢帧 */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve());
    else setTimeout(resolve, 0);
  });
}

// 启动后空闲时预热（首次初始化约 300ms），第一次滚到代码块时不再现场初始化
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => void loadHighlighter().catch(() => {}));
}

/**
 * 把代码切成带双主题颜色的 token 行（`htmlStyle` 里是 `--shiki-light` / `--shiki-dark`）。
 * 不支持的语言返回 null，调用方按纯文本显示。`signal` 中止（块已卸载）时跳过分词。
 */
export async function highlight(
  code: string,
  lang: string,
  signal?: AbortSignal
): Promise<ThemedToken[][] | null> {
  const language = resolveLanguage(lang);
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = cacheKey(code, language);
  const cached = cache.get(key);
  if (cached) return cached;

  const core = await loadHighlighter();
  if (!core.getLoadedLanguages().includes(language)) {
    await idle();
    if (signal?.aborted) return null;
    await core.loadLanguage(LANGUAGES[language]());
  }
  await idle();
  if (signal?.aborted) return null;
  // 等待期间别的挂载可能已经算好了
  const ready = cache.get(key);
  if (ready) return ready;
  const { tokens } = core.codeToTokens(code, {
    lang: language,
    themes: CODE_THEMES,
    defaultColor: false,
  });
  cache.set(key, tokens);
  return tokens;
}
