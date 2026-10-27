import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppDetectionDeps,
  allowedOpenWithAppsUpdate,
  appDetectionDeps,
  buildOpenWithLaunch,
  createVsCodeDetector,
  launchApplication,
  rememberPickedApp,
  validCustomAppPath,
} from './openWith';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));

function fakeDetection(
  platform: NodeJS.Platform,
  paths: string[] = [],
  env: NodeJS.ProcessEnv = {}
) {
  const files = new Set(paths);
  const deps: AppDetectionDeps = {
    platform,
    env,
    exists: (path) => files.has(path),
    executable: (path) => files.has(path),
    exec: vi.fn(async () => ''),
  };
  return { files, deps, detect: createVsCodeDetector(deps) };
}

describe('VS Code detection', () => {
  it('resolves a Windows code.cmd locator to its real Code.exe and never launches the cmd', async () => {
    const { deps, detect } = fakeDetection('win32', ['D:\\Editors\\VS Code\\Code.exe']);
    vi.mocked(deps.exec).mockResolvedValue('D:\\Editors\\VS Code\\bin\\code.cmd\r\n');
    expect(await detect()).toBe('D:\\Editors\\VS Code\\Code.exe');
    expect(deps.exec).toHaveBeenCalledWith('where.exe', ['code.cmd']);
  });

  it.each([
    [
      'LOCALAPPDATA',
      'C:\\Users\\me\\AppData\\Local',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    ],
    ['ProgramFiles', 'C:\\Program Files', 'C:\\Program Files\\Microsoft VS Code\\Code.exe'],
  ])('falls back to %s after a failed/timed out PATH lookup', async (key, root, expected) => {
    const { deps, detect } = fakeDetection('win32', [expected], { [key]: root });
    vi.mocked(deps.exec).mockRejectedValue(new Error('timeout'));
    expect(await detect()).toBe(expected);
  });

  it('does not treat code.cmd itself as a launchable target', async () => {
    const { deps, detect } = fakeDetection('win32', ['C:\\code\\bin\\code.cmd']);
    vi.mocked(deps.exec).mockResolvedValue('C:\\code\\bin\\code.cmd');
    expect(await detect()).toBeUndefined();
  });

  it('uses an app bundle on macOS and an executable on Linux PATH', async () => {
    expect(await fakeDetection('darwin', ['/Applications/Visual Studio Code.app']).detect()).toBe(
      '/Applications/Visual Studio Code.app'
    );
    const { deps, detect } = fakeDetection('linux', ['/opt/bin/code'], {
      PATH: '.:/missing:/opt/bin',
    });
    expect(await detect()).toBe('/opt/bin/code');
    expect(deps.exec).not.toHaveBeenCalled();
    expect(
      await fakeDetection('linux', ['relative/code'], { PATH: 'relative' }).detect()
    ).toBeUndefined();
  });

  it('caches negative results and concurrent probes until explicitly refreshed', async () => {
    const { deps, files, detect } = fakeDetection('win32');
    const first = detect();
    expect(detect()).toBe(first);
    expect(await first).toBeUndefined();
    files.add('C:\\Code\\Code.exe');
    vi.mocked(deps.exec).mockResolvedValue('C:\\Code\\bin\\code.cmd');
    expect(await detect()).toBeUndefined();
    expect(await detect(true)).toBe('C:\\Code\\Code.exe');
    expect(deps.exec).toHaveBeenCalledTimes(2);
  });

  it('bounds the real execFile probe with a timeout', async () => {
    mocks.execFile.mockImplementationOnce((_file, _args, options, callback) => {
      expect(options).toMatchObject({ timeout: 1500, windowsHide: true });
      callback(null, 'found');
    });
    await expect(appDetectionDeps().exec('where.exe', ['code.cmd'])).resolves.toBe('found');
  });
});

describe('safe application launching', () => {
  const folder = 'C:\\repos\\space & %PATH% $(touch nope)';

  it('passes the entire folder as one argument with no shell', () => {
    expect(buildOpenWithLaunch('C:\\Apps\\Editor.exe', folder, 'win32')).toEqual({
      file: 'C:\\Apps\\Editor.exe',
      args: [folder],
      options: { detached: true, stdio: 'ignore', shell: false },
    });
    expect(buildOpenWithLaunch('/bin/editor', '/tmp/space;$(nope)', 'linux').args).toEqual([
      '/tmp/space;$(nope)',
    ]);
  });

  it.each(['C:\\editor.cmd', 'C:\\editor.BAT'])('refuses Windows batch scripts: %s', (file) => {
    expect(() => buildOpenWithLaunch(file, folder, 'win32')).toThrow();
  });

  it('opens macOS app bundles through the fixed system executable with separate arguments', () => {
    expect(buildOpenWithLaunch('/Applications/Editor.app', '/tmp/a & b', 'darwin')).toEqual({
      file: '/usr/bin/open',
      args: ['-a', '/Applications/Editor.app', '/tmp/a & b'],
      options: { detached: true, stdio: 'ignore', shell: false },
    });
  });

  it('reports a macOS Launch Services failure even when open itself spawned successfully', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    const failed = launchApplication('/Applications/Broken.app', '/tmp/project', 'darwin');
    child.emit('spawn');
    child.emit('exit', 1);
    await expect(failed).rejects.toThrow('Application launcher exited with code 1');
    const opened = launchApplication('/Applications/Editor.app', '/tmp/project', 'darwin');
    child.emit('spawn');
    child.emit('exit', 0);
    await expect(opened).resolves.toBeUndefined();
  });

  it('unrefs only after spawning and reports asynchronous spawn failures', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    const launched = launchApplication(process.execPath, folder);
    expect(child.unref).not.toHaveBeenCalled();
    child.emit('spawn');
    await expect(launched).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledOnce();
    const failed = launchApplication(process.execPath, folder);
    child.emit('error', new Error('ENOENT'));
    await expect(failed).rejects.toThrow('ENOENT');
  });
});

describe('custom application picker provenance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows saved entries and freshly picked apps only for their originating window', () => {
    const picked = rememberPickedApp(process.execPath, 7);
    expect(validCustomAppPath(picked.path)).toBe(true);
    expect(allowedOpenWithAppsUpdate([picked], [], 7)).toBe(true);
    expect(allowedOpenWithAppsUpdate([picked], [], 8)).toBe(false);
    expect(allowedOpenWithAppsUpdate([{ ...picked, path: '/elsewhere' }], [], 7)).toBe(false);
    expect(allowedOpenWithAppsUpdate([{ ...picked, id: 'fabricated' }], [], 7)).toBe(false);
    expect(allowedOpenWithAppsUpdate([{ ...picked, name: 'Renamed' }], [picked], 8)).toBe(true);
    expect(allowedOpenWithAppsUpdate([], [picked], 8)).toBe(true);
  });

  it('rejects non-existent or relative executable paths', () => {
    expect(validCustomAppPath('relative.exe')).toBe(false);
    expect(validCustomAppPath('/definitely-not-an-installed-app/editor.exe')).toBe(false);
  });
});
