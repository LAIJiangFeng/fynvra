import { basename, join } from 'node:path';
import { errorMessage } from '@shared/guards';
import type {
  InstructionEntry,
  InstructionScan,
  InstructionSource,
} from '../../../preload/domains/instructions';
import { normalizedInstructionPath, readInstructionFile } from './instructionRegistry';

const LOCATIONS = [
  { id: 'claude', relative: '.claude/CLAUDE.md' },
  { id: 'codex', relative: '.codex/AGENTS.md' },
  { id: 'gemini', relative: '.gemini/GEMINI.md' },
  { id: 'opencode', relative: '.config/opencode/AGENTS.md' },
  { id: 'home', relative: 'AGENTS.md' },
] as const;

/** Candidate IDs only select fixed locations; they never contain a path supplied by Renderer. */
export function instructionCandidate(
  id: unknown,
  home: string
): { path: string; source: InstructionSource } | undefined {
  const location = LOCATIONS.find((item) => item.id === id);
  return location ? { path: join(home, location.relative), source: location.id } : undefined;
}

export async function scanInstructions(options: {
  home: string;
  registered: readonly InstructionEntry[];
  platform?: NodeJS.Platform;
}): Promise<InstructionScan> {
  const { home, registered, platform = process.platform } = options;
  const paths = new Set(
    registered.flatMap((entry) => {
      const path = entry.kind === 'linked' ? entry.path : entry.importedFrom;
      return path ? [normalizedInstructionPath(path, platform)] : [];
    })
  );
  const result: InstructionScan = { candidates: [], warnings: [] };
  for (const location of LOCATIONS) {
    const path = join(home, location.relative);
    try {
      const content = await readInstructionFile(path);
      result.candidates.push({
        id: location.id,
        name: basename(path),
        source: location.id,
        path,
        size: Buffer.byteLength(content, 'utf8'),
        charCount: content.length,
        registered: paths.has(normalizedInstructionPath(path, platform)),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.warnings.push(`${path}: ${errorMessage(error)}`);
      }
    }
  }
  return result;
}
