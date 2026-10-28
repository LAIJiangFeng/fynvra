import { parsePreferences, type ShellKind } from '@shared/types/settings';
import { describe, expect, it, vi } from 'vitest';
import {
  availableShells,
  defaultTerminalShell,
  describeShells,
  resolveAgentShell,
  resolveTerminalShell,
  type ShellDetectionDeps,
  validShellPreference,
} from './shells';

const paths = {
  pwsh: 'D:\\PowerShell\\pwsh.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  cmd: 'C:\\Windows\\System32\\cmd.exe',
  'git-bash': 'D:\\Git\\bin\\bash.exe',
  wsl: 'C:\\Windows\\System32\\wsl.exe',
};
function fake(
  existing: string[] = Object.values(paths),
  overrides: Partial<ShellDetectionDeps> = {}
) {
  const files = new Set(existing);
  const deps: ShellDetectionDeps = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    exec: vi.fn(async (_file, args) =>
      args[0] === 'pwsh.exe' ? `${paths.pwsh}\r\n` : 'D:\\Git\\cmd\\git.exe\r\n'
    ),
    existsSync: (path) => files.has(path),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, files };
}

describe('availableShells', () => {
  it('lists existing Windows executables with stable ids and pi compatibility', async () => {
    const { deps } = fake();
    expect(await availableShells(deps)).toEqual([
      { id: 'pwsh', label: 'PowerShell 7', path: paths.pwsh, agentSupported: true },
      {
        id: 'powershell',
        label: 'Windows PowerShell 5.1',
        path: paths.powershell,
        agentSupported: true,
      },
      { id: 'cmd', label: 'cmd', path: paths.cmd, agentSupported: false },
      { id: 'git-bash', label: 'Git Bash', path: paths['git-bash'], agentSupported: true },
      { id: 'wsl', label: 'WSL', path: paths.wsl, agentSupported: false },
    ]);
    expect(deps.exec).toHaveBeenCalledWith('C:\\Windows\\System32\\where.exe', ['pwsh.exe']);
    expect(deps.exec).toHaveBeenCalledTimes(2);
  });

  it('omits missing and relative executables', async () => {
    const { deps } = fake(['pwsh.exe'], {
      exec: async () => 'pwsh.exe',
      env: { ComSpec: 'cmd.exe' },
    });
    expect(await availableShells(deps)).toEqual([]);
  });

  it('falls back when where fails or times out, and honors ComSpec', async () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const cmd = 'D:\\Windows\\cmd.exe';
    const { deps } = fake([pwsh, cmd], {
      env: { ProgramFiles: 'C:\\Program Files', ComSpec: cmd },
      exec: async () => {
        throw new Error('timeout');
      },
    });
    expect((await availableShells(deps)).map(({ id, path }) => ({ id, path }))).toEqual([
      { id: 'pwsh', path: pwsh },
      { id: 'cmd', path: cmd },
    ]);
  });

  it('skips missing first PATH matches and prefers PATH over ProgramFiles', async () => {
    const { deps } = fake([paths.pwsh, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'], {
      exec: async (_file, args) =>
        args[0] === 'pwsh.exe' ? `C:\\gone\\pwsh.exe\n${paths.pwsh}` : '',
    });
    expect((await availableShells(deps))[0]?.path).toBe(paths.pwsh);
  });

  it('prefers a regular ProgramFiles install without probing Appx or aliases', async () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const exec = vi.fn(async () => '');
    const { deps } = fake([pwsh, paths.powershell], {
      env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      exec,
    });
    expect((await availableShells(deps))[0]?.path).toBe(pwsh);
    expect(exec.mock.calls).toHaveLength(2);
  });

  it('lists only login shell and existing minimal Unix shells without invoking where', async () => {
    const { deps } = fake(['/usr/local/bin/fish', '/bin/bash', '/bin/sh'], {
      platform: 'darwin',
      env: { SHELL: '/usr/local/bin/fish' },
    });
    expect((await availableShells(deps)).map(({ id, path }) => ({ id, path }))).toEqual([
      { id: 'login', path: '/usr/local/bin/fish' },
      { id: 'bash', path: '/bin/bash' },
      { id: 'sh', path: '/bin/sh' },
    ]);
    expect(deps.exec).not.toHaveBeenCalled();
  });
});

describe('Store PowerShell discovery', () => {
  const local = 'C:\\Users\\测试 用户\\AppData\\Local';
  const aliasPath = `${local}\\Microsoft\\WindowsApps\\pwsh.exe`;
  const home = 'D:\\应用 安装\\WindowsApps\\Microsoft.PowerShell_7.5.0.0_x64__8wekyb3d8bbwe';
  const executable = `${home}\\pwsh.exe`;
  const where = 'C:\\Windows\\System32\\where.exe';

  function probe(
    appx: string | Error,
    alias: string | Error = new Error('alias disabled'),
    pathResult = '',
    existing = [paths.powershell, paths['git-bash'], executable]
  ) {
    return fake(existing, {
      env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: local },
      exec: vi.fn(async (file, args) => {
        if (file === where) {
          return args[0] === 'pwsh.exe' ? pathResult : 'D:\\Git\\cmd\\git.exe';
        }
        const result = file === paths.powershell ? appx : alias;
        if (result instanceof Error) throw result;
        return result;
      }),
    });
  }

  it.each(['', aliasPath])(
    'resolves a Store install when PATH returns %j and the alias fails the file check',
    async (pathResult) => {
      const { deps, files } = probe(JSON.stringify([home]), undefined, pathResult);
      const preferences = parsePreferences({
        terminalShell: { kind: 'pwsh' },
        agentShell: { kind: 'pwsh' },
      });
      const info = await describeShells(preferences, deps);
      expect(info).toMatchObject({
        shells: expect.arrayContaining([
          { id: 'pwsh', label: 'PowerShell 7', path: executable, agentSupported: true },
        ]),
        terminalPath: executable,
        agentPath: executable,
        defaultTerminalPath: paths.powershell,
        defaultAgentPath: paths['git-bash'],
      });
      expect(resolveTerminalShell(preferences.terminalShell, info.shells, deps)).toEqual({
        path: executable,
        args: ['-NoLogo'],
      });
      expect(
        resolveTerminalShell({ kind: 'custom', path: executable }, info.shells, deps).path
      ).toBe(executable);
      expect(deps.exec).toHaveBeenCalledWith(paths.powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining('Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction Stop'),
      ]);
      expect(deps.exec).not.toHaveBeenCalledWith(aliasPath, expect.anything());
      files.delete(executable);
      expect(resolveTerminalShell(preferences.terminalShell, info.shells, deps)).toEqual(
        defaultTerminalShell(deps)
      );
      expect(resolveAgentShell(preferences, info.shells, deps)).toBe(paths['git-bash']);
    }
  );

  it.each([
    new Error('EACCES'),
    new Error('ETIMEDOUT'),
    '',
    'invalid json',
    'null',
    '{}',
    JSON.stringify(home),
    '[]',
    JSON.stringify([null, {}, 'relative', 'C:relative', '\\rooted', 'C:\\gone']),
  ])(
    'resolves the known alias to a regular executable after unusable Appx output %j',
    async (appx) => {
      const { deps } = probe(appx, JSON.stringify(home));
      const info = await describeShells(
        parsePreferences({ terminalShell: { kind: 'pwsh' } }),
        deps
      );
      expect(info.terminalPath).toBe(executable);
      expect(info.shells.find((shell) => shell.id === 'pwsh')?.path).toBe(executable);
      expect(deps.exec).toHaveBeenCalledWith(aliasPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining('$PSHOME'),
      ]);
    }
  );

  it('uses the alias when Windows PowerShell/Appx is unavailable', async () => {
    const { deps } = probe('', JSON.stringify(home), '', [executable]);
    const info = await describeShells(
      parsePreferences({ terminalShell: { kind: 'pwsh' }, agentShell: { kind: 'pwsh' } }),
      deps
    );
    expect(info.terminalPath).toBe(executable);
    expect(info.agentPath).toBe(executable);
    expect(deps.exec).not.toHaveBeenCalledWith(paths.powershell, expect.anything());
  });

  it('skips inaccessible or stale Appx locations before the usable install', async () => {
    const { deps } = probe(JSON.stringify(['C:\\inaccessible', 'C:\\removed', home]));
    expect((await availableShells(deps))[0]?.path).toBe(executable);
  });

  it.each([
    new Error('ENOENT'),
    new Error('EACCES'),
    new Error('ETIMEDOUT'),
    '',
    'invalid json',
    'null',
    '{}',
    '[]',
    JSON.stringify('relative'),
    JSON.stringify('C:relative'),
    JSON.stringify('\\rooted'),
    JSON.stringify('C:\\gone'),
  ])('keeps other shells and defaults when Appx and alias cannot resolve: %j', async (alias) => {
    const { deps } = probe('[]', alias);
    const info = await describeShells(
      parsePreferences({ terminalShell: { kind: 'pwsh' }, agentShell: { kind: 'pwsh' } }),
      deps
    );
    expect(info.shells.map((shell) => shell.id)).toEqual(['powershell', 'git-bash']);
    expect(info.terminalPath).toBe(paths.powershell);
    expect(info.agentPath).toBe(paths['git-bash']);
  });

  it('rejects an alias home whose real executable fails the file check', async () => {
    const { deps } = probe('[]', JSON.stringify(home), aliasPath, [paths.powershell]);
    expect((await availableShells(deps)).map((shell) => shell.id)).toEqual(['powershell']);
  });

  it('never launches a relative LOCALAPPDATA alias', async () => {
    const { deps } = probe('[]', JSON.stringify(home));
    deps.env.LOCALAPPDATA = 'relative';
    expect((await availableShells(deps)).some((shell) => shell.id === 'pwsh')).toBe(false);
    expect(deps.exec).toHaveBeenCalledTimes(3);
  });
});

describe('terminal shell resolution', () => {
  it.each<[ShellKind, string[]]>([
    ['pwsh', ['-NoLogo']],
    ['powershell', ['-NoLogo']],
    ['cmd', []],
    ['git-bash', ['--login', '-i']],
    ['wsl', []],
  ])('uses arguments for explicit %s', async (kind, args) => {
    const { deps } = fake();
    const shells = await availableShells(deps);
    expect(resolveTerminalShell({ kind }, shells, deps)).toEqual({
      path: paths[kind as keyof typeof paths],
      args,
    });
  });

  it('preserves default -NoProfile and falls back when a detected or custom executable disappears', async () => {
    const { deps, files } = fake();
    const shells = await availableShells(deps);
    const fallback = { path: paths.powershell, args: ['-NoLogo', '-NoProfile'] };
    expect(resolveTerminalShell(undefined, shells, deps)).toEqual(fallback);
    files.delete(paths.pwsh);
    expect(resolveTerminalShell({ kind: 'pwsh' }, shells, deps)).toEqual(fallback);
    expect(resolveTerminalShell({ kind: 'custom', path: paths.pwsh }, shells, deps)).toEqual(
      fallback
    );
    expect(resolveTerminalShell({ kind: 'zsh' }, shells, deps)).toEqual(fallback);
  });

  it('passes no args to custom shells, and keeps Unix login behavior', async () => {
    const { deps } = fake(['/bin/zsh', '/bin/sh', '/opt/fish'], {
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
    });
    const shells = await availableShells(deps);
    expect(resolveTerminalShell(undefined, shells, deps)).toEqual({
      path: '/bin/zsh',
      args: ['-l'],
    });
    expect(resolveTerminalShell({ kind: 'sh' }, shells, deps)).toEqual({
      path: '/bin/sh',
      args: ['-l'],
    });
    expect(resolveTerminalShell({ kind: 'custom', path: '/opt/fish' }, shells, deps)).toEqual({
      path: '/opt/fish',
      args: [],
    });
    expect(defaultTerminalShell({ ...deps, env: {} })).toEqual({ path: '/bin/sh', args: ['-l'] });
  });
});

describe('agent shell resolution', () => {
  it('legacy shellPath wins over a selected shell, including a missing legacy executable', async () => {
    const { deps } = fake();
    const preferences = parsePreferences({
      shellPath: 'D:\\legacy\\bash.exe',
      agentShell: { kind: 'pwsh' },
    });
    expect(resolveAgentShell(preferences, await availableShells(deps), deps)).toBe(
      preferences.shellPath
    );
  });

  it('resolves compatible selections, falls back after removal, and never picks cmd or WSL', async () => {
    const { deps, files } = fake();
    const shells = await availableShells(deps);
    expect(resolveAgentShell({ agentShell: { kind: 'pwsh' } }, shells, deps)).toBe(paths.pwsh);
    expect(
      resolveAgentShell({ agentShell: { kind: 'custom', path: paths.powershell } }, shells, deps)
    ).toBe(paths.powershell);
    files.delete(paths.pwsh);
    expect(resolveAgentShell({ agentShell: { kind: 'pwsh' } }, shells, deps)).toBe(
      paths['git-bash']
    );
    for (const kind of ['cmd', 'wsl'] as const) {
      expect(resolveAgentShell({ agentShell: { kind } }, shells, deps)).toBe(paths['git-bash']);
      expect(
        resolveAgentShell({ agentShell: { kind: 'custom', path: paths[kind] } }, shells, deps)
      ).toBe(paths['git-bash']);
    }
    files.delete(paths['git-bash']);
    expect(resolveAgentShell({}, shells, deps)).toBe(paths.powershell);
    expect(resolveAgentShell({ agentShell: { kind: 'pwsh' } }, shells, deps)).toBe(
      paths.powershell
    );
    files.delete(paths.powershell);
    expect(resolveAgentShell({}, shells, deps)).toBeUndefined();
  });

  it('uses the same default fallback order in session resolution and settings paths', async () => {
    const { deps, files } = fake();
    const defaults = parsePreferences({});
    for (const expected of [paths['git-bash'], paths.powershell, paths.pwsh]) {
      const shells = await availableShells(deps);
      expect(resolveAgentShell({}, shells, deps)).toBe(expected);
      expect(await describeShells(defaults, deps)).toMatchObject({
        defaultAgentPath: expected,
        agentPath: expected,
      });
      files.delete(expected);
    }
    expect(await describeShells(defaults, deps)).toMatchObject({
      defaultAgentPath: undefined,
      agentPath: undefined,
    });
  });

  it('ignores the Windows preference on other platforms', () => {
    const { deps } = fake([], { platform: 'linux' });
    expect(resolveAgentShell({ agentShell: { kind: 'pwsh' } }, [], deps)).toBeUndefined();
  });

  it('validates custom paths for the host OS and rejects known incompatible agent launchers', () => {
    const { deps } = fake();
    for (const path of [
      'relative',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\bash.exe',
      paths.wsl,
    ]) {
      expect(validShellPreference({ kind: 'custom', path }, true, deps)).toBe(false);
    }
    expect(
      validShellPreference({ kind: 'custom', path: 'C:\\tools\\pwsh.exe' }, false, {
        ...deps,
        platform: 'linux',
      })
    ).toBe(false);
  });

  it('reports effective paths, including missing selection fallbacks and legacy overrides', async () => {
    const { deps } = fake();
    const info = await describeShells(
      parsePreferences({ shellPath: 'D:\\custom\\bash.exe', terminalShell: { kind: 'zsh' } }),
      deps
    );
    expect(info).toMatchObject({
      defaultAgentPath: paths['git-bash'],
      defaultTerminalPath: paths.powershell,
      agentPath: 'D:\\custom\\bash.exe',
      terminalPath: paths.powershell,
    });
  });
});
