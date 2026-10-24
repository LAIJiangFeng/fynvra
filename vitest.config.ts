import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fromRoot('./src/shared'),
      '@': fromRoot('./src/renderer'),
      '@fynvra/core': fromRoot('./packages/core/src/index.ts'),
      '@fynvra/agent-runtime': fromRoot('./packages/agent-runtime/src/index.ts'),
      // Main 模块顶层会 import electron；node 环境下换成桩，用例再按需 vi.mock
      electron: fromRoot('./test/stubs/electron.ts'),
      '@electron-toolkit/utils': fromRoot('./test/stubs/electron-toolkit-utils.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'packages/*/src/**/*.test.ts'],
  },
});
