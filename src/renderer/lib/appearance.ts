import { type AppearancePreferences, DEFAULT_APPEARANCE_PREFERENCES } from '@shared/types/settings';

/** 界面字体留空时的内置字体栈（Tailwind 的 --font-sans 默认值）；只用作设置页的占位提示 */
export const DEFAULT_UI_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";

interface AppearanceSource {
  getState(): { appearance: AppearancePreferences };
  subscribe(
    listener: (
      state: { appearance: AppearancePreferences },
      previous: { appearance: AppearancePreferences }
    ) => void
  ): () => void;
}

const UI_KEYS = ['uiFontFamily', 'uiFontSize', 'uiFontWeight'] as const;

/** 空值不写行内样式，回到样式表；先删再写，浏览器不认的值也不会留下上一次的值 */
function setStyle(style: CSSStyleDeclaration, property: string, value: string): void {
  style.removeProperty(property);
  if (value) style.setProperty(property, value);
}

/**
 * 把界面的字体、字号、字重写到 `<html>`，设置变了立即生效。
 * 根字号 = 16 × 正文字号 / 14：Tailwind 的 rem 尺寸随之缩放，相当于整体缩放界面。
 * 字体同时覆盖 --font-sans，`font-sans` 的文字也跟着换；`font-mono` 的代码块、diff 不受影响。
 * 字重是正文的默认字重，显式设了字重的文字不受影响。是默认值的项不写行内样式。
 */
export function bindDocumentAppearance(store: AppearanceSource): () => void {
  const apply = () => {
    const { uiFontFamily, uiFontSize, uiFontWeight } = store.getState().appearance;
    const { style } = document.documentElement;
    const defaults = DEFAULT_APPEARANCE_PREFERENCES;
    setStyle(
      style,
      'font-size',
      uiFontSize === defaults.uiFontSize ? '' : `${(16 * uiFontSize) / 14}px`
    );
    setStyle(style, 'font-weight', uiFontWeight === defaults.uiFontWeight ? '' : uiFontWeight);
    setStyle(style, 'font-family', uiFontFamily);
    setStyle(style, '--font-sans', uiFontFamily);
  };
  apply();
  return store.subscribe((state, previous) => {
    if (UI_KEYS.some((key) => state.appearance[key] !== previous.appearance[key])) apply();
  });
}
