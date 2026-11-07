import { externalLink } from '../FileMarkdownPreview';
import type { LiveContext } from './shared';

/** 源码中的链接目标：去掉 `<...>` 包裹；GFM 的 www. 裸链接按 http 处理（与 remark-gfm 一致）。 */
export function linkTarget(raw: string, bare = false): string {
  const url = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  return bare && /^www\./i.test(url) ? `http://${url}` : url;
}

/**
 * Ctrl/Cmd+点击打开链接，规则与只读预览一致：http(s) 交给 Main 的新窗口拦截（系统浏览器），
 * 本地相对路径经 references 解析后在文件区打开，其他协议一律忽略。
 */
export function createLinkOpener(ctx: LiveContext) {
  let pending: symbol | null = null;
  return {
    /** 编辑内容或卸载后，晚到的本地解析不能再打开文件。 */
    cancel() {
      pending = null;
    },
    open(href: string) {
      const external = externalLink(href);
      if (external) {
        window.open(external, '_blank', 'noreferrer');
        return;
      }
      if (!href || !ctx.references.isLocal(href)) return;
      const request = Symbol();
      pending = request;
      void ctx.references.resolveFile(href).then((entry) => {
        const state = ctx.store.getState();
        if (
          entry &&
          pending === request &&
          state.selectedId === ctx.file.id &&
          state.opened.some(
            (source) => source.id === ctx.file.id && source.relativePath === ctx.file.relativePath
          )
        )
          void state.openFile(entry);
      });
    },
  };
}

export type LinkOpener = ReturnType<typeof createLinkOpener>;
