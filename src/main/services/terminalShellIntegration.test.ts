import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import type { AvailableShell, ShellPreference } from '@shared/types/settings';
import { describe, expect, it } from 'vitest';
import { resolveTerminalShell, shellDetectionDeps } from './shells';
import { terminalShellIntegration } from './terminalShellIntegration';

const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const pwsh = 'D:\\PowerShell\\pwsh.exe';
const encoded = terminalShellIntegration({ path: pwsh, args: [] }, 'win32').args.at(-1) as string;
const bootstrap = Buffer.from(encoded, 'base64').toString('utf16le');
const suffix = ['-NoExit', '-EncodedCommand', encoded];

function resolve(preference?: ShellPreference, missing = false) {
  const shells: AvailableShell[] = [
    { id: 'pwsh', label: 'PowerShell 7', path: pwsh, agentSupported: true },
    {
      id: 'powershell',
      label: 'Windows PowerShell',
      path: windowsPowerShell,
      agentSupported: true,
    },
  ];
  const deps = shellDetectionDeps({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    existsSync: () => !missing,
  });
  return terminalShellIntegration(resolveTerminalShell(preference, shells, deps), deps.platform);
}

describe('workspace terminal PowerShell arguments', () => {
  it('keeps the default shell and NoProfile, including invalid selection fallbacks', () => {
    const expected = { path: windowsPowerShell, args: ['-NoLogo', '-NoProfile', ...suffix] };
    expect(resolve()).toEqual(expected);
    expect(resolve({ kind: 'pwsh' }, true)).toEqual(expected);
    expect(resolve({ kind: 'custom', path: pwsh }, true)).toEqual(expected);
    expect(resolve({ kind: 'zsh' })).toEqual(expected);
    expect(resolve({ kind: 'custom', path: 'relative/pwsh.exe' })).toEqual(expected);
  });

  it.each(['pwsh', 'powershell'] as const)('preserves explicit %s profile loading', (kind) => {
    expect(resolve({ kind })).toEqual({
      path: kind === 'pwsh' ? pwsh : windowsPowerShell,
      args: ['-NoLogo', ...suffix],
    });
  });

  it('recognizes custom PowerShell by basename without embedding its path into code', () => {
    const path = "D:\\tools $special; 'name'\\PoWeRsHeLl.EXE";
    expect(resolve({ kind: 'custom', path })).toEqual({ path, args: suffix });
    expect(bootstrap).not.toContain(path);
  });

  it.each<[NodeJS.Platform, string, string[]]>([
    ['win32', 'C:\\Windows\\System32\\cmd.exe', []],
    ['win32', 'D:\\Git\\bin\\bash.exe', ['--login', '-i']],
    ['win32', 'C:\\Windows\\System32\\wsl.exe', []],
    ['win32', 'D:\\pwsh.exe\\custom.exe', []],
    ['win32', 'D:\\custom-powershell.exe', []],
    ['win32', 'pwsh.exe', []],
    ['linux', '/bin/bash', ['-l']],
    ['darwin', '/bin/zsh', ['-l']],
    ['linux', '/opt/custom', []],
    ['linux', 'C:\\tools\\pwsh.exe', []],
  ])('leaves %s %s untouched', (platform, path, args) => {
    const shell = { path, args };
    expect(terminalShellIntegration(shell, platform)).toBe(shell);
  });

  it.each(['linux', 'darwin'] as const)('supports real pwsh paths on %s', (platform) => {
    const deps = shellDetectionDeps({ platform, env: { SHELL: '/opt/pwsh' } });
    const shell = resolveTerminalShell(undefined, [], deps);
    expect(terminalShellIntegration(shell, platform)).toEqual({
      path: '/opt/pwsh',
      args: ['-l', ...suffix],
    });
    expect(shell.args).toEqual(['-l']);
    expect(terminalShellIntegration({ path: '/usr/local/bin/pwsh', args: [] }, platform)).toEqual({
      path: '/usr/local/bin/pwsh',
      args: suffix,
    });
  });
});

// All subprocesses use NoProfile + NonInteractive. They never call ReadLine(), load history,
// save commands, or start the application. PowerShell-less CI still runs argument coverage.
function execute(file: string, source: string) {
  return spawnSync(
    file,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(source, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 }
  );
}

const hosts = (
  process.platform === 'win32'
    ? [
        win32.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe'
        ),
        'pwsh.exe',
      ]
    : ['pwsh']
).map((file) => ({
  file,
  available: execute(file, '$PSVersionTable.PSVersion.ToString()').status === 0,
}));

function run(file: string, source: string) {
  const result = execute(file, `$ErrorActionPreference = 'Stop'\n${source}`);
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

// Isolate the bootstrap from host capabilities while executing its actual PowerShell code.
const fakeReadLine = `
Add-Type -TypeDefinition @'
namespace Microsoft.PowerShell {
    public static class PSConsoleReadLine {
        public static string Line = "cd";
        public static int Cursor = 2;
        public static string Suggestion;
        public static bool FailAccept;
        public static int AcceptCalls;
        public static int BackwardCalls;
        public static void GetBufferState(ref string line, ref int cursor) { line = Line; cursor = Cursor; }
        public static void AcceptSuggestion(object key, object arg) {
            AcceptCalls++;
            if (FailAccept) throw new System.InvalidOperationException("unavailable prediction");
            if (!string.IsNullOrEmpty(Suggestion)) { Line = Suggestion; Cursor = Line.Length; }
        }
        public static void BackwardChar(object key, object arg) {
            BackwardCalls++;
            Cursor = System.Math.Max(0, Cursor - 1);
        }
    }
}
'@
New-Module -Name PSReadLine -ScriptBlock {
    function Set-PSReadLineOption {
        [CmdletBinding()]
        param($PredictionSource, $PredictionViewStyle, $Colors)
        $global:Options = $PSBoundParameters
    }
    function Set-PSReadLineKeyHandler {
        [CmdletBinding()]
        param($Key, $BriefDescription, $ScriptBlock)
        $global:BoundKey = $Key
        $global:Handler = $ScriptBlock
    }
    Export-ModuleMember -Function Set-PSReadLineOption, Set-PSReadLineKeyHandler
} | Import-Module -Global
# Prevent the bootstrap's import from replacing this in-memory fixture with a disk module.
function Import-Module {
    [CmdletBinding()]
    param($Name, [switch]$Global)
    if ($Name -ne 'PSReadLine' -or -not $Global) { throw 'Unexpected module import' }
}
`;

for (const { file, available } of hosts) {
  describe.skipIf(!available)(`PowerShell bootstrap in ${file}`, () => {
    it('configures only History/InlineView/color and LeftArrow in the current session', () => {
      const output = run(
        file,
        `${fakeReadLine}\n${bootstrap}\n
        if (-not $global:Handler) { throw "Handler missing: $($Error[0])" }
        if (Get-Variable options -Scope Global -ErrorAction SilentlyContinue) {
          # The only global Options here is the fixture capture, not a leaked bootstrap local.
          if ($global:Options -isnot [System.Collections.IDictionary]) { throw 'Scope leaked' }
        }
        @{
          Source = $global:Options.PredictionSource
          View = $global:Options.PredictionViewStyle
          Color = $global:Options.Colors.InlinePrediction.ToString()
          Key = $global:BoundKey
        } | ConvertTo-Json -Compress
      `
      );
      expect(JSON.parse(output)).toEqual({
        Source: 'History',
        View: 'InlineView',
        Color: 'DarkGray',
        Key: 'LeftArrow',
      });
    }, 30_000);

    it('accepts only at line end and falls back on absent, unchanged, or throwing suggestions', () => {
      const output = run(
        file,
        `${fakeReadLine}\n${bootstrap}\n
        $t = [Microsoft.PowerShell.PSConsoleReadLine]
        function Check($line, $cursor, $suggestion, $fail, $expectedLine, $expectedCursor, $accept, $backward) {
          $t::Line = $line
          $t::Cursor = $cursor
          $t::Suggestion = $suggestion
          $t::FailAccept = $fail
          $t::AcceptCalls = 0
          $t::BackwardCalls = 0
          & $global:Handler $null $null
          if ($t::Line -cne $expectedLine -or $t::Cursor -ne $expectedCursor -or
              $t::AcceptCalls -ne $accept -or $t::BackwardCalls -ne $backward) {
            throw "Unexpected result for '$line' at $cursor (suggestion '$suggestion'): '$($t::Line)' at $($t::Cursor), accept $($t::AcceptCalls), backward $($t::BackwardCalls)"
          }
        }
        Check 'cd' 2 'cd example' $false 'cd example' 10 1 0
        Check 'cd' 1 'cd example' $false 'cd' 0 0 1
        Check 'cd' 2 $null $false 'cd' 1 1 1
        Check 'cd' 2 'cd' $false 'cd' 1 1 1
        Check 'cd' 2 'cd example' $true 'cd' 1 1 1
        Check '' 0 $null $false '' 0 1 1
        'passed'
      `
      );
      expect(output).toBe('passed');
    }, 30_000);

    it('handles missing modules without preventing the next command', () => {
      const output = run(
        file,
        `
        function Import-Module { throw 'module unavailable' }
        ${bootstrap}
        'terminal still usable'
      `
      );
      expect(output).toContain('Upgrade PSReadLine to 2.2+');
      expect(output).toContain('Tab completion is unchanged.');
      expect(output).toContain('terminal still usable');
    }, 30_000);

    it('checks installed capabilities, keeps native bindings, and handles unsupported/redirected hosts', () => {
      const output = run(
        file,
        String.raw`
        Import-Module PSReadLine -ErrorAction Stop
        $before = @(PSReadLine\Get-PSReadLineKeyHandler -Bound | Where-Object { $_.Key -in @('Tab', 'RightArrow', 'Ctrl+c') } | Select-Object Key,Function | ConvertTo-Json -Compress)
        ${bootstrap}
        $after = @(PSReadLine\Get-PSReadLineKeyHandler -Bound | Where-Object { $_.Key -in @('Tab', 'RightArrow', 'Ctrl+c') } | Select-Object Key,Function | ConvertTo-Json -Compress)
        if (Compare-Object $before $after) { throw 'Native key binding changed' }
        'terminal still usable'
      `
      );
      // Even modern PSReadLine cannot enable VT prediction when stdout is redirected.
      expect(output).toContain('History suggestions unavailable.');
      expect(output).toContain('terminal still usable');
    }, 30_000);

    it('falls back after the real AcceptSuggestion returns without accepting a prediction', () => {
      const output = run(
        file,
        String.raw`
        Import-Module PSReadLine -ErrorAction Stop
        $t = [Microsoft.PowerShell.PSConsoleReadLine]
        if (-not $t.GetMember('AcceptSuggestion')) { 'unsupported'; exit 0 }
        $flags = [Reflection.BindingFlags]'Instance,NonPublic'
        $instance = $t.GetField('_singleton', [Reflection.BindingFlags]'Static,NonPublic').GetValue($null)
        $buffer = $t.GetField('_buffer', $flags).GetValue($instance)
        [void]$buffer.Append('cd')
        $t.GetField('_current', $flags).SetValue($instance, 2)
        $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
        $tokens = $null
        $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw ($errors | Out-String) }
        $command = $ast.Find({ param($node)
          $node -is [Management.Automation.Language.CommandAst] -and
          $node.GetCommandName() -eq 'PSReadLine\Set-PSReadLineKeyHandler'
        }, $true)
        $handler = ($command.CommandElements | Where-Object {
          $_ -is [Management.Automation.Language.ScriptBlockExpressionAst]
        }).ScriptBlock.Extent.Text
        # Only intercept the final cursor movement: it needs a real console device.
        # AcceptSuggestion and GetBufferState still use the installed PSReadLine implementation.
        Add-Type 'public static class BackwardProbe { public static int Calls; public static void BackwardChar(object key, object arg) { Calls++; } }'
        $handler = $handler.Replace('[Microsoft.PowerShell.PSConsoleReadLine]::BackwardChar', '[BackwardProbe]::BackwardChar')
        $block = [ScriptBlock]::Create($handler.Substring(1, $handler.Length - 2))
        & $block $null $null
        $line = ''
        $cursor = 0
        $t::GetBufferState([ref]$line, [ref]$cursor)
        if ($line -cne 'cd' -or [BackwardProbe]::Calls -ne 1) { throw 'No-op accept swallowed LeftArrow' }
        'native fallback passed'
      `
      );
      expect(['unsupported', 'native fallback passed']).toContain(output);
    }, 30_000);
  });
}
