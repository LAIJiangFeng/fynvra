import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const vitest = pathToFileURL(require.resolve('vitest/node')).href;
// Use the shipped runtime's SQLite (including FTS5), even when pnpm runs on
// Node 22/23 builds without FTS5. This starts no Electron app or GUI.
// biome-ignore lint/style/noRestrictedImports: Node test resolves the installed executable, not Electron APIs.
const electron: string = require('electron');
const fixture = 'test/fixtures/magicContext.startup.ts';

// Magic caches SQLite handles, environment paths and session ownership globally.
// A fresh process per case exercises worker startup without reusing a previous
// plugin import or leaving open database handles when removing the sandbox.
describe('Magic Context real worker startup', () => {
  for (const layout of ['development', 'packaged']) {
    for (const scenario of ['valid', 'fail-open', 'invalid-schema']) {
      it(`${layout}: ${scenario}`, async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'fynvra-magic-startup-'));
        try {
          await exec(
            electron,
            [
              '--input-type=module',
              '-e',
              `import { startVitest } from ${JSON.stringify(vitest)};
const ctx = await startVitest('test', [], {
  root: ${JSON.stringify(root)},
  config: ${JSON.stringify(join(root, 'vitest.config.ts'))},
  include: [${JSON.stringify(fixture)}],
  watch: false, pool: 'threads', maxWorkers: 1, fileParallelism: false,
});
if (!ctx) process.exitCode = 1;
else {
  if (ctx.state.getFiles().length !== 1 || ctx.state.getCountOfFailedTests() || ctx.state.getUnhandledErrors().length) process.exitCode = 1;
  await ctx.close();
}`,
            ],
            {
              cwd: sandbox,
              env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                FYNVRA_MAGIC_TEST_ROOT: root,
                FYNVRA_MAGIC_TEST_SANDBOX: sandbox,
                FYNVRA_MAGIC_TEST_LAYOUT: layout,
                FYNVRA_MAGIC_TEST_SCENARIO: scenario,
                PI_CODING_AGENT_DIR: join(sandbox, 'agent'),
              },
              timeout: 45_000,
              maxBuffer: 2 * 1024 * 1024,
              windowsHide: true,
            }
          );
        } finally {
          await rm(sandbox, { recursive: true, force: true });
        }
      }, 60_000);
    }
  }
});
