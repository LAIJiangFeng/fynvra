import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { bindDocumentTheme } from './lib/theme';
import { useSettingsStore } from './stores/settings';
import './styles/globals.css';

/** 偏好读回来之前最多等这么久：读取失败时 persist 不会报完成 */
const PREFERENCES_WAIT_MS = 1_000;

/** 等 Main 回包偏好再渲染：选了非系统语言时，首帧不先闪一下系统语言 */
function whenPreferencesLoaded(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, PREFERENCES_WAIT_MS);
    unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

bindDocumentTheme(useSettingsStore);

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
