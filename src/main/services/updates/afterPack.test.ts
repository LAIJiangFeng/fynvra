import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const afterPack = createRequire(import.meta.url)('../../../../scripts/afterPack.cjs') as (context: {
  electronPlatformName: string;
  appOutDir: string;
}) => Promise<void>;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('afterPack spawn-helper', () => {
  it('makes every packaged spawn-helper executable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fynvra-afterpack-'));
    const prebuilds = join(
      dir,
      'Fynvra.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64'
    );
    mkdirSync(prebuilds, { recursive: true });
    const helper = join(prebuilds, 'spawn-helper');
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
    await afterPack({ electronPlatformName: 'darwin', appOutDir: dir });
    if (process.platform !== 'win32') expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('fails a mac build without spawn-helper and ignores Windows', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fynvra-afterpack-'));
    await expect(afterPack({ electronPlatformName: 'darwin', appOutDir: dir })).rejects.toThrow(
      'spawn-helper not found'
    );
    await expect(afterPack({ electronPlatformName: 'linux', appOutDir: dir })).resolves.toBe(
      undefined
    );
    await expect(afterPack({ electronPlatformName: 'win32', appOutDir: dir })).resolves.toBe(
      undefined
    );
  });
});
