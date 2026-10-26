import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInstructionRegistry } from './instructionRegistry';
import { instructionCandidate, scanInstructions } from './scanInstructions';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.instruction-scan-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function file(relative: string) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'Instructions 指令');
  return path;
}

describe('scanInstructions', () => {
  it('finds all supported home locations without registering or modifying them', async () => {
    for (const relative of [
      '.claude/CLAUDE.md',
      '.codex/AGENTS.md',
      '.gemini/GEMINI.md',
      '.config/opencode/AGENTS.md',
      'AGENTS.md',
    ])
      await file(relative);
    const result = await scanInstructions({ home: root, registered: [] });
    expect(result.candidates.map((item) => item.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
      'home',
    ]);
    expect(result.candidates.every((item) => item.size > item.charCount && !item.registered)).toBe(
      true
    );
    expect(result.warnings).toEqual([]);
  });
  it('missing locations are a valid empty scan; unreadable locations produce a warning', async () => {
    expect(await scanInstructions({ home: root, registered: [] })).toEqual({
      candidates: [],
      warnings: [],
    });
    await mkdir(join(root, '.claude', 'CLAUDE.md'), { recursive: true });
    const result = await scanInstructions({ home: root, registered: [] });
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
  it('marks duplicate paths, including local copies imported from that path', async () => {
    const path = await file('.claude/CLAUDE.md');
    const registry = createInstructionRegistry({ userData: join(root, 'userData') });
    await registry.addLinked(path, 'claude');
    const scan = () =>
      registry.list().then((registered) => scanInstructions({ home: root, registered }));
    expect((await scan()).candidates[0]?.registered).toBe(true);
    const [entry] = await registry.list();
    await registry.save({ id: entry?.id ?? '', name: 'Copy', content: 'edited' });
    expect((await scan()).candidates[0]?.registered).toBe(true);
  });
  it('candidate IDs cannot select arbitrary paths', () => {
    for (const id of ['../AGENTS.md', '.claude/CLAUDE.md', 'claude:../../secret', root, null, {}])
      expect(instructionCandidate(id, root)).toBeUndefined();
    expect(instructionCandidate('claude', root)).toEqual({
      path: join(root, '.claude/CLAUDE.md'),
      source: 'claude',
    });
  });
});
