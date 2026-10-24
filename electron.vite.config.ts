import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const sharedAlias = { '@shared': fromRoot('./src/shared') };
// workspace 内的 TS 源码包经 alias 直接打进产物。不要把它们写进根 dependencies：
// externalizeDeps 会把 dependencies 外置成运行时 import，而包入口是 .ts，运行时无法加载。
const coreAlias = { '@fynvra/core': fromRoot('./packages/core/src/index.ts') };
const agentRuntimeAlias = {
  '@fynvra/agent-runtime': fromRoot('./packages/agent-runtime/src/index.ts'),
};

export default defineConfig({
  main: {
    // Agent worker（src/agent/index.ts）不是第二个入口：Main 以 `?modulePath` 引用它
    // （services/agentHost/electronWorker.ts），electron-vite 用本段配置单独构建成 out/main/chunks/ 下的文件，
    // alias 与 externalizeDeps 都沿用这里。pi 因此要写进根 dependencies，否则会被打进 worker 产物。
    resolve: { alias: { ...sharedAlias, ...coreAlias, ...agentRuntimeAlias } },
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // "type": "module" 下 preload 默认产出 ESM（.mjs），而 ESM preload 必须关闭沙箱；
      // 改为 CommonJS 以保留 sandbox: true。preload 只依赖 electron，无需打包第三方模块。
      rolldownOptions: { output: { format: 'cjs' } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fromRoot('./src/renderer'), ...sharedAlias, ...coreAlias },
    },
  },
});
