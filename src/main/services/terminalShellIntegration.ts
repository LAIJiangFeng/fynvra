import { posix, win32 } from 'node:path';

// Kept in the Main bundle: no on-disk script, user code, cwd interpolation, or PTY input.
// The child scope keeps bootstrap variables out of the interactive session. Import globally
// so PSConsoleHostReadLine remains available after this scope ends, including with -NoProfile.
const powershellBootstrap = String.raw`& {
  try {
    Import-Module PSReadLine -Global -ErrorAction Stop
    $options = Get-Command PSReadLine\Set-PSReadLineOption -ErrorAction Stop
    if (-not $options.Parameters.ContainsKey('PredictionSource') -or
        -not $options.Parameters.ContainsKey('PredictionViewStyle') -or
        -not [Microsoft.PowerShell.PSConsoleReadLine].GetMember('AcceptSuggestion')) {
      throw 'PSReadLine does not support inline predictions.'
    }
    PSReadLine\Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView -Colors @{ InlinePrediction = [ConsoleColor]::DarkGray } -ErrorAction Stop
    PSReadLine\Set-PSReadLineKeyHandler -Key LeftArrow -BriefDescription AcceptHistoryOrBackwardChar -ScriptBlock {
      param($key, $arg)
      $line = ''
      $cursor = 0
      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
      if ($cursor -eq $line.Length) {
        try {
          [Microsoft.PowerShell.PSConsoleReadLine]::AcceptSuggestion($key, $arg)
          $after = ''
          $afterCursor = 0
          [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$after, [ref]$afterCursor)
          if ($after -cne $line) { return }
        } catch {
          # A missing, dismissed, or unavailable prediction must not swallow LeftArrow.
        }
      }
      [Microsoft.PowerShell.PSConsoleReadLine]::BackwardChar($key, $arg)
    } -ErrorAction Stop
  } catch {
    Write-Host 'Fynvra: History suggestions unavailable. Upgrade PSReadLine to 2.2+ or select PowerShell 7 with PSReadLine 2.2+ in Settings. Tab completion is unchanged.' -ForegroundColor DarkYellow
  }
}`;

const encodedBootstrap = Buffer.from(powershellBootstrap, 'utf16le').toString('base64');

/** Only workspace terminals call this; agent shells and existing PTYs are unaffected. */
export function terminalShellIntegration(
  shell: { path: string; args: string[] },
  platform: NodeJS.Platform = process.platform
): { path: string; args: string[] } {
  const paths = platform === 'win32' ? win32 : posix;
  if (
    !paths.isAbsolute(shell.path) ||
    !/^(?:pwsh|powershell)(?:\.exe)?$/i.test(paths.basename(shell.path))
  ) {
    return shell;
  }
  return {
    path: shell.path,
    args: [...shell.args, '-NoExit', '-EncodedCommand', encodedBootstrap],
  };
}
