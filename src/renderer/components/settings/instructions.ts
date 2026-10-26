import type { T } from '@/i18n';
import type { InstructionSource } from '../../../preload/domains/instructions';

export function instructionSourceLabel(source: InstructionSource, t: T): string {
  switch (source) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini CLI';
    case 'opencode':
      return 'OpenCode';
    case 'home':
      return t('settings.instructions.home');
    case 'manual':
      return t('settings.instructions.manual');
  }
}

export function instructionSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
