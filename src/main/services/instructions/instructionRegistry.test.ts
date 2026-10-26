import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInstructionRegistry,
  type InstructionRegistry,
  normalizedInstructionPath,
  parseStoredInstruction,
} from './instructionRegistry';

let root: string;
let userData: string;
let source: string;
let registry: InstructionRegistry;
beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.instructions-test-'));
  userData = join(root, 'userData');
  source = join(root, 'CLAUDE.md');
  await writeFile(source, 'Original 指令\n');
  registry = createInstructionRegistry({ userData, now: () => 123 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function linked() {
  await registry.addLinked(source, 'claude');
  const entry = (await registry.list())[0];
  if (!entry) throw new Error('missing test entry');
  return entry;
}

describe('instruction registry', () => {
  it('registers links, reads live, and deletes only the entry, leaving source bytes intact', async () => {
    const entry = await linked();
    expect(entry).toMatchObject({
      name: 'CLAUDE.md',
      kind: 'linked',
      enabled: false,
      createdAt: 123,
    });
    expect(await registry.read(entry.id)).toMatchObject({ content: 'Original 指令\n' });
    await writeFile(source, 'Changed externally');
    expect(await registry.read(entry.id)).toMatchObject({ content: 'Changed externally' });
    expect(await registry.views()).toMatchObject([{ size: 18, charCount: 18 }]);
    await registry.remove(entry.id);
    expect(await readFile(source, 'utf8')).toBe('Changed externally');
    expect(await registry.list()).toEqual([]);
  });

  it('editing a link creates an owned copy and remembers its source; later edits stay local', async () => {
    const entry = await linked();
    await registry.setEnabled(entry.id, true);
    await registry.save({ id: entry.id, name: 'My instructions', content: 'Local version' });
    expect(await registry.read(entry.id)).toMatchObject({
      entry: {
        id: entry.id,
        name: 'My instructions',
        kind: 'local',
        importedFrom: source,
        source: 'claude',
        enabled: true,
      },
      content: 'Local version',
    });
    await registry.save({ id: entry.id, name: 'My instructions', content: 'Second version' });
    expect(await readFile(source, 'utf8')).toBe('Original 指令\n');
    expect(await registry.resolve(undefined)).toEqual({
      name: 'My instructions',
      content: 'Second version',
    });
    expect(await readdir(join(userData, 'instructions'))).toHaveLength(1);
    await registry.remove(entry.id);
    expect(await readFile(source, 'utf8')).toBe('Original 指令\n');
    expect(await readdir(join(userData, 'instructions'))).toEqual([]);
  });

  it('creates and persists local files with metadata only in JSON', async () => {
    await registry.save({ name: 'Local', content: 'large text lives separately' });
    const [entry] = await registry.list();
    expect(entry).toMatchObject({ kind: 'local', source: 'manual', enabled: false });
    const json = await readFile(join(userData, 'instructions.json'), 'utf8');
    expect(json).not.toContain('large text lives separately');
    const reopened = createInstructionRegistry({ userData });
    expect(await reopened.read(entry?.id ?? '')).toMatchObject({
      content: 'large text lives separately',
    });
  });

  it('serializes concurrent enables so at most one is active, and permits all off', async () => {
    const first = await linked();
    await registry.save({ name: 'Second', content: 'second' });
    const second = (await registry.list())[1];
    if (!second) throw new Error('missing second');
    await Promise.all([registry.setEnabled(first.id, true), registry.setEnabled(second.id, true)]);
    expect((await registry.list()).map((entry) => entry.enabled)).toEqual([false, true]);
    await registry.setEnabled(second.id, false);
    expect((await registry.list()).every((entry) => !entry.enabled)).toBe(true);
    await expect(registry.setEnabled('missing', true)).rejects.toThrow();
    expect(await registry.resolve(undefined)).toBeUndefined();
  });

  it('resolves follow-global / none / explicit including globally disabled files without fallback', async () => {
    const first = await linked();
    await registry.setEnabled(first.id, true);
    await registry.save({ name: 'Specific', content: 'Specific content' });
    const second = (await registry.list())[1];
    expect(await registry.resolve(undefined)).toEqual({
      name: 'CLAUDE.md',
      content: 'Original 指令\n',
    });
    expect(await registry.resolve(null)).toBeUndefined();
    expect(await registry.resolve(second?.id)).toEqual({
      name: 'Specific',
      content: 'Specific content',
    });
    expect(await registry.resolve('removed')).toBeUndefined();
    await writeFile(source, 'New source');
    expect(await registry.resolve(undefined)).toMatchObject({ content: 'New source' });
  });

  it('warns on missing or unreadable links and injects nothing, then recovers live', async () => {
    const entry = await linked();
    await registry.setEnabled(entry.id, true);
    await rm(source);
    expect(await registry.resolve(undefined)).toBeUndefined();
    expect(await registry.resolve(entry.id)).toBeUndefined();
    expect((await registry.views())[0]?.warning).toBeTruthy();
    // A directory is unreadable as a text file on every supported platform.
    await mkdir(source);
    expect(await registry.resolve(entry.id)).toBeUndefined();
    expect((await registry.views())[0]?.warning).toContain('not a file');
    await rm(source, { recursive: true });
    await writeFile(source, 'Restored');
    expect(await registry.resolve(entry.id)).toMatchObject({ content: 'Restored' });
    expect((await registry.views())[0]?.warning).toBeUndefined();
  });

  it('deduplicates normalized source paths, including edited imports', async () => {
    const entry = await linked();
    expect(await registry.addLinked(join(root, '.', 'CLAUDE.md'), 'manual')).toBe(false);
    await registry.save({ id: entry.id, name: 'Copy', content: 'content' });
    expect(await registry.addLinked(source, 'claude')).toBe(false);
    expect(normalizedInstructionPath('C:\\Users\\Me\\.claude\\..\\CLAUDE.md', 'win32')).toBe(
      normalizedInstructionPath('c:/users/me/CLAUDE.md', 'win32')
    );
  });

  it('rejects invalid drafts without changing the registered file', async () => {
    const entry = await linked();
    for (const draft of [
      { id: entry.id, name: '', content: 'x' },
      { id: entry.id, name: 'x', content: 'a'.repeat(2 * 1024 * 1024 + 1) },
      { id: entry.id, name: 'x', content: '\0' },
      { id: 'removed', name: 'x', content: 'x' },
    ])
      await expect(registry.save(draft)).rejects.toThrow();
    expect((await registry.list())[0]?.kind).toBe('linked');
    expect(await readFile(source, 'utf8')).toBe('Original 指令\n');
    expect(
      parseStoredInstruction({ ...entry, kind: 'local', fileName: '../CLAUDE.md' })
    ).toBeNull();
  });

  it('does not follow a replaced local-copy directory outside userData for writes or cleanup', async () => {
    await registry.save({ name: 'Local', content: 'Owned copy' });
    const [entry] = await registry.list();
    if (entry?.kind !== 'local') throw new Error('missing local entry');
    const external = join(root, 'external');
    await mkdir(external);
    const original = join(external, entry.fileName);
    await writeFile(original, 'User file');
    const copies = join(userData, 'instructions');
    await rm(copies, { recursive: true });
    await symlink(external, copies, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      registry.save({ id: entry.id, name: 'Edited', content: 'Must not write' })
    ).rejects.toThrow('symbolic link');
    expect(await registry.resolve(entry.id)).toBeUndefined();
    await registry.remove(entry.id);
    expect(await readFile(original, 'utf8')).toBe('User file');
    expect(await readdir(external)).toEqual([entry.fileName]);
  });

  it('preserves the previous copy when the metadata commit fails', async () => {
    await registry.save({ name: 'Local', content: 'Before failure' });
    const [entry] = await registry.list();
    const metadata = join(userData, 'instructions.json');
    await rm(metadata);
    await mkdir(metadata);
    await expect(
      registry.save({ id: entry?.id ?? '', name: 'Local', content: 'Must not replace' })
    ).rejects.toThrow();
    expect(await registry.read(entry?.id ?? '')).toMatchObject({ content: 'Before failure' });
    expect(await readdir(join(userData, 'instructions'))).toHaveLength(1);
  });
});
