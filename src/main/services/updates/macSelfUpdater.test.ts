import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({
  plistVersion: '0.2.0',
  execFile: vi.fn(),
  spawn: vi.fn(),
  accessSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: child.execFile, spawn: child.spawn }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  accessSync: child.accessSync,
}));

const {
  createMacSelfUpdater,
  INSTALL_SCRIPT,
  installTarget,
  isNewerVersion,
  MANIFEST_URL,
  parseMacManifest,
} = await import('./macSelfUpdater');
const { createUpdateService } = await import('./service');

const zip = Buffer.alloc(300_000, 7);
const sha512 = createHash('sha512').update(zip).digest('base64');
const manifest = (version = '0.2.0', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version,
    files: ['x64', 'arm64'].map((arch) => ({
      arch,
      url: `Fynvra-${version}-mac-${arch}.zip`,
      sha512,
      size: zip.length,
      ...extra,
    })),
  });
const BUNDLE = '/Applications/Fynvra.app';

let temp: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'fynvra-mac-update-'));
  child.plistVersion = '0.2.0';
  child.accessSync.mockReset();
  child.spawn.mockReset().mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  child.execFile.mockReset().mockImplementation((file: string, _args: string[], callback) => {
    if (file === '/usr/bin/plutil') callback(null, `${child.plistVersion}\n`);
    else if (file === '/usr/bin/xattr') callback(new Error('no quarantine'));
    else callback(null, '');
  });
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function setup(body: Buffer = zip, text = manifest()) {
  const quit = vi.fn();
  const fetch = vi.fn(async (url: string) =>
    url === MANIFEST_URL ? new Response(text) : new Response(new Uint8Array(body))
  );
  const updater = createMacSelfUpdater({
    currentVersion: '0.1.0',
    arch: 'arm64',
    execPath: `${BUNDLE}/Contents/MacOS/Fynvra`,
    tempDir: temp,
    fetch,
    quit,
    notWritableMessage: () => '请移到应用程序',
  });
  return { updater, fetch, quit };
}

describe('Mac 自更新清单', () => {
  it('按架构收窄字段，拒绝损坏、路径越界、预发布和缺架构的清单', () => {
    expect(parseMacManifest(manifest(), 'x64')).toEqual({
      version: '0.2.0',
      url: 'Fynvra-0.2.0-mac-x64.zip',
      sha512,
      size: zip.length,
    });
    for (const text of [
      'version: 0.2.0',
      '[]',
      manifest('0.2.0-beta.1'),
      manifest('0.2.0', { url: '../evil.zip' }),
      manifest('0.2.0', { sha512: 'abc' }),
      manifest('0.2.0', { size: -1 }),
      JSON.stringify({ version: '0.2.0', files: [] }),
    ]) {
      expect(() => parseMacManifest(text, 'arm64')).toThrow();
    }
  });
  it('只有更高的稳定版本才算新版本', () => {
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0-beta.1', '0.1.0')).toBe(false);
  });
  it('相同或更旧的版本报告无更新，不下载', async () => {
    const { updater, fetch } = setup(zip, manifest('0.1.0'));
    const events: string[] = [];
    updater.on('update-not-available', () => events.push('not-available'));
    await updater.checkForUpdates();
    expect(events).toEqual(['not-available']);
    await expect(updater.downloadUpdate()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Mac 自更新下载与安装', () => {
  it('按服务期望的事件完成检查、下载、校验，并在退出后分离启动替换脚本', async () => {
    const { updater, fetch, quit } = setup();
    const service = createUpdateService({
      updater,
      currentVersion: '0.1.0',
      broadcast: vi.fn(),
      notify: vi.fn(),
      requestQuit: vi.fn(),
    });
    service.check();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloaded'));
    expect(service.getState().version).toBe('0.2.0');
    expect(fetch).toHaveBeenLastCalledWith(
      'https://github.com/LAIJiangFeng/fynvra/releases/download/v0.2.0/Fynvra-0.2.0-mac-arm64.zip'
    );
    const work = join(temp, 'fynvra-update', '0.2.0');
    const bundle = join(work, 'app', 'Fynvra.app');
    expect(child.execFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/usr/bin/ditto', ['-x', '-k', join(work, 'Fynvra-0.2.0-mac-arm64.zip'), join(work, 'app')]],
      [
        '/usr/bin/plutil',
        [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          '-o',
          '-',
          join(bundle, 'Contents', 'Info.plist'),
        ],
      ],
      ['/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle]],
    ]);
    expect(existsSync(join(work, 'Fynvra-0.2.0-mac-arm64.zip'))).toBe(false);

    expect(service.requestInstall()).toBe(true);
    expect(service.finishInstall()).toBe(true);
    const script = join(temp, 'fynvra-update', 'install.sh');
    expect(child.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [
        script,
        String(process.pid),
        BUNDLE,
        bundle,
        join(temp, 'fynvra-update', 'backup.app'),
        work,
      ],
      { detached: true, stdio: 'ignore' }
    );
    expect(child.spawn.mock.results[0].value.unref).toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });
  it('替换脚本只引用带引号的位置参数，失败时还原备份', () => {
    expect(INSTALL_SCRIPT).toContain('kill -0 "$pid"');
    expect(INSTALL_SCRIPT).toContain('if mv "$target" "$backup"; then');
    expect(INSTALL_SCRIPT).toContain('mv "$backup" "$target"');
    expect(INSTALL_SCRIPT).toContain('/usr/bin/open -n "$target"');
    expect(INSTALL_SCRIPT).not.toMatch(/\$[a-z]+[^"a-z]/);
  });
  it('SHA512 不匹配时删除下载并报错', async () => {
    const { updater } = setup(Buffer.alloc(zip.length, 8));
    await updater.checkForUpdates();
    await expect(updater.downloadUpdate()).rejects.toThrow('checksum');
    expect(existsSync(join(temp, 'fynvra-update', '0.2.0'))).toBe(false);
    expect(child.execFile).not.toHaveBeenCalled();
  });
  it('解压出的应用版本与清单不符时报错且不进入待安装', async () => {
    child.plistVersion = '0.1.9';
    const { updater } = setup();
    const downloaded = vi.fn();
    updater.on('update-downloaded', downloaded);
    await updater.checkForUpdates();
    await expect(updater.downloadUpdate()).rejects.toThrow('version mismatch');
    expect(downloaded).not.toHaveBeenCalled();
    expect(() => updater.quitAndInstall()).toThrow();
  });
  it('拒绝替换 App Translocation、外置卷或不可写位置的应用', async () => {
    expect(
      installTarget('/private/var/folders/x/AppTranslocation/ab/d/Fynvra.app/Contents/MacOS/Fynvra')
    ).toBeUndefined();
    expect(installTarget('/Volumes/Fynvra/Fynvra.app/Contents/MacOS/Fynvra')).toBeUndefined();
    expect(installTarget('/usr/local/bin/fynvra')).toBeUndefined();
    expect(installTarget(`${BUNDLE}/Contents/MacOS/Fynvra`)).toBe(BUNDLE);
    child.accessSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const { updater, quit } = setup();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    expect(() => updater.quitAndInstall()).toThrow('请移到应用程序');
    expect(child.spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});
