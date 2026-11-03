import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { bindDocumentAppearance } from './lib/appearance';
import { bindDocumentTheme } from './lib/theme';
import { useAppearanceStore, useSettingsStore } from './stores/settings';
import { bindTerminalAppearance } from './stores/terminals';
import './styles/globals.css';

/** 偏好读回来之前最多等这么久：读取失败时 persist 不会报完成 */
const PREFERENCES_WAIT_MS = 1_000;

/** 等 Main 回包偏好再渲染：选了非系统语言时，首帧不先闪一下系统语言；界面字号、字体也不先闪一下默认值 */
function whenPreferencesLoaded(): Promise<void> {
  const loaded = () =>
    useSettingsStore.persist.hasHydrated() && useAppearanceStore.getState().loaded;
  if (loaded()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribes: (() => void)[] = [];
    const finish = () => {
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, PREFERENCES_WAIT_MS);
    const check = () => {
      if (loaded()) finish();
    };
    unsubscribes.push(
      useSettingsStore.persist.onFinishHydration(check),
      useAppearanceStore.subscribe(check)
    );
  });
}

bindDocumentTheme(useSettingsStore);
bindDocumentAppearance(useAppearanceStore);
bindTerminalAppearance(useAppearanceStore);

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');
const root = createRoot(container);

void whenPreferencesLoaded().then(() => {
  root.render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>
  );
});
