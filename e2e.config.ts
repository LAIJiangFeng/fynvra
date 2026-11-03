import { fileURLToPath } from 'node:url';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
import { fynvraElectron } from './e2e/fynvraElectron';
import { SEED } from './e2e/seed';

/** 仓库根目录：按本文件位置推算，不依赖运行 e2e 时的工作目录（e2e mcp 也用这份配置）。 */
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
/** 托管构建后 renderer 的固定 loopback 地址；主窗口经 ELECTRON_RENDERER_URL 加载它。 */
const rendererUrl = 'http://127.0.0.1:5199';

export default {
  tests: 'e2e/**/*.e2e.ts',
  workers: 1,
  // 每个 attempt 的启动预算包含拉起 Electron，留出比 provider 自身 60 s 等待更多的余量。
  launchTimeout: 90_000,
  targets: [
    {
      name: 'electron',
      engine: web({
        browser: fynvraElectron({ projectRoot, rendererUrl, seed: SEED }),
        // 页面铺满 Fynvra 自己的窗口，不模拟 1280x720 视口。
        viewport: null,
      }),
      app: {
        url: rendererUrl,
        command: {
          // 用运行 e2e 的同一个 Node，不取决于 PATH 里先找到哪个 node。
          executable: process.execPath,
          args: [
            'node_modules/vite/bin/vite.js',
            'preview',
            '--outDir',
            'out/renderer',
            '--host',
            '127.0.0.1',
            '--port',
            '{port}',
            '--strictPort',
          ],
        },
      },
    },
  ],
} satisfies E2EConfig;
