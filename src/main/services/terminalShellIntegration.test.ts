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
$global:Bindings = @()
New-Module -Name PSReadLine -ScriptBlock {
    function Set-PSReadLineOption {
        [CmdletBinding()]
        param($PredictionSource, $PredictionViewStyle, $Colors)
        $global:Options = $PSBoundParameters
    }
    function Set-PSReadLineKeyHandler {
        [CmdletBinding()]
        param($Key, $Function, [scriptblock]$ScriptBlock)
        $global:Bindings += @(@{ Key = $Key; Function = $Function; Custom = ($null -ne $ScriptBlock) })
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
    it('configures History/InlineView/color and binds only RightArrow to native ForwardChar', () => {
      const output = run(
        file,
        `${fakeReadLine}\n${bootstrap}\n
        @{
          Source = $global:Options.PredictionSource
          View = $global:Options.PredictionViewStyle
          Color = $global:Options.Colors.InlinePrediction.ToString()
          Bindings = $global:Bindings
        } | ConvertTo-Json -Compress
      `
      );
      expect(JSON.parse(output)).toEqual({
        Source: 'History',
        View: 'InlineView',
        Color: 'DarkGray',
        Bindings: [{ Key: 'RightArrow', Function: 'ForwardChar', Custom: false }],
      });
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
      expect(output).toContain('select PowerShell 7 in General settings, then open a new terminal');
      expect(output).toContain('Tab completion is unchanged.');
      expect(output).toContain('terminal still usable');
    }, 30_000);

    it('checks installed capabilities, keeps native bindings, and handles host configuration outcomes', () => {
      const output = run(
        file,
        String.raw`
        Import-Module PSReadLine -ErrorAction Stop
        $before = @(PSReadLine\Get-PSReadLineKeyHandler -Bound | Where-Object { $_.Key -in @('Tab', 'RightArrow', 'LeftArrow', 'Ctrl+c') } | Sort-Object Key | Select-Object Key,Function)
        $messages = @(& { ${bootstrap} } 6>&1 | ForEach-Object { $_.ToString() })
        $options = PSReadLine\Get-PSReadLineOption
        $after = @(PSReadLine\Get-PSReadLineKeyHandler -Bound | Where-Object { $_.Key -in @('Tab', 'RightArrow', 'LeftArrow', 'Ctrl+c') } | Sort-Object Key | Select-Object Key,Function)
        @{
          Messages = $messages
          Source = [string]$options.PredictionSource
          View = [string]$options.PredictionViewStyle
          Before = $before
          After = $after
          NextCommand = 'terminal still usable'
        } | ConvertTo-Json -Depth 4 -Compress
      `
      );
      const { Messages, Source, View, Before, After, NextCommand } = JSON.parse(output);
      expect(NextCommand).toBe('terminal still usable');
      if (Messages.length === 0) {
        expect(Source).toBe('History');
        expect(View).toBe('InlineView');
        expect(After).toContainEqual({ Key: 'RightArrow', Function: 'ForwardChar' });
        expect(After).toEqual(
          Before.map((binding: { Key: string; Function: string }) =>
            binding.Key === 'RightArrow' ? { ...binding, Function: 'ForwardChar' } : binding
          )
        );
      } else {
        expect(Messages).toEqual([
          'Fynvra: History suggestions unavailable. Upgrade PSReadLine to 2.2+ or select PowerShell 7 in General settings, then open a new terminal. Tab completion is unchanged.',
        ]);
        expect(After).toEqual(Before);
      }
    }, 30_000);

    it('uses native RightArrow acceptance only at line end and leaves LeftArrow untouched', () => {
      const output = run(
        file,
        String.raw`
        Import-Module PSReadLine -ErrorAction Stop
        $t = [Microsoft.PowerShell.PSConsoleReadLine]
        if (-not $t.GetMember('AcceptSuggestion')) { 'unsupported'; exit 0 }
        $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
        $tokens = $null
        $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw ($errors | Out-String) }
        $command = $ast.Find({ param($node)
          $node -is [Management.Automation.Language.CommandAst] -and
          $node.GetCommandName() -eq 'PSReadLine\Set-PSReadLineKeyHandler'
        }, $true)
        # Execute the shipped binding against the real module; enabling VT output itself
        # needs a terminal, so only the configuration test above substitutes that command.
        PSReadLine\Set-PSReadLineKeyHandler -Key RightArrow -Function EndOfLine
        PSReadLine\Set-PSReadLineKeyHandler -Key LeftArrow -Function BeginningOfLine
        & ([ScriptBlock]::Create($command.Extent.Text))
        $right = PSReadLine\Get-PSReadLineKeyHandler -Chord RightArrow
        $left = PSReadLine\Get-PSReadLineKeyHandler -Chord LeftArrow
        if ($right.Function -ne 'ForwardChar' -or $left.Function -ne 'BeginningOfLine') {
          throw 'Incorrect arrow bindings'
        }
        $forward = $t.GetMethod($right.Function)
        $flags = [Reflection.BindingFlags]'Instance,Static,NonPublic'
        $instance = $t.GetField('_singleton', $flags).GetValue($null)
        $buffer = $t.GetField('_buffer', $flags).GetValue($instance)
        $current = $t.GetField('_current', $flags)
        $prediction = $t.GetField('_prediction', $flags).GetValue($instance)
        $view = $prediction.GetType().GetField('_inlineView', $flags).GetValue($prediction)
        $suggestion = $view.GetType().GetField('_suggestionText', $flags)
        # Use PSReadLine's deferred-render path to test real buffer edits headlessly.
        # No ReadLine(), console device, history file, or substitute editing method is used.
        $queued = $t.GetField('_queuedKeys', $flags).GetValue($instance)
        1..11 | ForEach-Object { $queued.Enqueue($null) }
        $t.GetField('_lastRenderTime', $flags).SetValue($instance, (New-Object Diagnostics.Stopwatch))
        $t.GetField('_waitingToRender', $flags).SetValue($instance, $true)
        $edits = $t.GetField('_edits', $flags)
        $edits.SetValue($instance, [Activator]::CreateInstance($edits.FieldType))
        function Check($text, $cursor, $predictionText, $expectedText, $expectedCursor) {
          [void]$buffer.Clear()
          [void]$buffer.Append($text)
          $current.SetValue($instance, $cursor)
          $suggestion.SetValue($view, $predictionText)
          [void]$forward.Invoke($null, @($null, $null))
          $line = ''
          $position = 0
          $t::GetBufferState([ref]$line, [ref]$position)
          if ($line -cne $expectedText -or $position -ne $expectedCursor) {
            throw "Expected '$expectedText' at $expectedCursor, got '$line' at $position"
          }
        }
        Check 'cd' 2 $null 'cd' 2
        Check 'cd' 0 'cd example' 'cd' 1
        Check 'cd' 0 $null 'cd' 1
        Check '' 0 $null '' 0
        Check 'cd' 2 'cd example' 'cd example' 10
        'native RightArrow checks passed'
      `
      );
      expect(['unsupported', 'native RightArrow checks passed']).toContain(output);
    }, 30_000);
  });
}
