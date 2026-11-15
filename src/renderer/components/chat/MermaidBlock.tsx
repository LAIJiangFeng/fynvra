import type { Mermaid } from 'mermaid';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';

type Result = { svg: string } | { error: string };

let loader: Promise<Mermaid> | undefined;
/** initialize + render 串行执行，主题切换时不会用错主题出图 */
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;
const MAX_CACHE = 50;
/** 虚拟列表重新挂载行时首帧直接取缓存，不闪 */
const cache = new Map<string, Result>();

const keyOf = (code: string, dark: boolean) => `${dark ? 'dark' : 'light'}\u0000${code}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function remember(key: string, result: Result) {
  cache.delete(key);
  cache.set(key, result);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

/** 渲染并缓存；语法错误也缓存（同一源码结果不变），库加载失败不缓存。 */
export function renderMermaid(code: string, dark: boolean): Promise<Result> {
  const key = keyOf(code, dark);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const task = queue.then(async () => {
    loader ??= import('mermaid').then((m) => m.default);
    const mermaid = await loader.catch((error) => {
      loader = undefined; // 加载失败下次重试
      throw error;
    });
    const id = `fynvra-mermaid-${++counter}`;
    // strict：mermaid 用 DOMPurify 清洗标签与最终 SVG 并禁用 click；secure 列表阻止 %%{init}%% 覆盖
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      suppressErrorRendering: true,
    });
    let result: Result;
    try {
      result = { svg: (await mermaid.render(id, code)).svg };
    } catch (error) {
      for (const selector of [`#d${id}`, `#${id}`]) document.querySelector(selector)?.remove();
      result = { error: messageOf(error) };
    }
    remember(key, result);
    return result;
  });
  queue = task.catch(() => {});
  return task;
}

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark'))
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** ```mermaid 代码块画成图；渲染中与失败时显示源码，复制按钮始终复制源码。 */
export function MermaidBlock({ code }: { code: string }) {
  const t = useT();
  const dark = useDark();
  const key = keyOf(code, dark);
  const [state, setState] = useState(() => ({ key, result: cache.get(key) }));
  const result = state.key === key ? state.result : cache.get(key);

  useEffect(() => {
    if (result) return;
    let live = true;
    renderMermaid(code, dark).then(
      (next) => live && setState({ key, result: next }),
      (error) => live && setState({ key, result: { error: messageOf(error) } })
    );
    // 卸载或 code/主题变化后到达的结果丢弃
    return () => {
      live = false;
    };
  }, [code, dark, key, result]);

  if (!result) return <CodeBlock code={code} lang="mermaid" />;
  if ('error' in result) {
    return (
      <div>
        <CodeBlock code={code} lang="mermaid" />
        <p className="-mt-2 mb-3 text-destructive text-xs">
          {t('chat.mermaidFailed', { error: result.error })}
        </p>
      </div>
    );
  }
  return (
    <div className="my-3 overflow-hidden rounded-lg border bg-muted/30">
      <div className="flex h-8 items-center justify-between border-b bg-muted/50 pr-1 pl-3">
        <span className="font-mono text-muted-foreground text-xs">mermaid</span>
        <CopyButton text={code} label={t('chat.copyCode')} />
      </div>
      <div
        className="overflow-x-auto p-3 [&>svg]:mx-auto [&>svg]:block"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: securityLevel strict 下 mermaid 已用 DOMPurify 清洗
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    </div>
  );
}
