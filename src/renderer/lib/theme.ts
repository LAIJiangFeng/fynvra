import type { ThemeMode } from '@shared/types/settings';

export type ColorScheme = 'light' | 'dark';

export function resolveColorScheme(theme: ThemeMode, prefersDark: boolean): ColorScheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

interface ThemeSource {
  getState(): { theme: ThemeMode };
  subscribe(
    listener: (state: { theme: ThemeMode }, previous: { theme: ThemeMode }) => void
  ): () => void;
}

/**
 * 把设置里的主题同步到 `<html class="dark">`；system 模式跟随系统明暗变化。
 * Main 同时把 nativeTheme.themeSource 设成同一主题，prefers-color-scheme 与之保持一致。
 */
export function bindDocumentTheme(store: ThemeSource): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const scheme = resolveColorScheme(store.getState().theme, media.matches);
    document.documentElement.classList.toggle('dark', scheme === 'dark');
  };
  apply();
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.theme !== previous.theme) apply();
  });
  media.addEventListener('change', apply);
  return () => {
    unsubscribe();
    media.removeEventListener('change', apply);
  };
}
