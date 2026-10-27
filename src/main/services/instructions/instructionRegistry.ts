import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve, win32 } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import type {
  InstructionDraft,
  InstructionEntry,
  InstructionSource,
  InstructionView,
} from '../../../preload/domains/instructions';
import { createJsonRegistry, isRegistryId } from '../providers/jsonRegistry';

const MAX_BYTES = 2 * 1024 * 1024;
const SOURCES: readonly InstructionSource[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'home',
  'manual',
];
const LOCAL_FILE = /^[0-9a-f-]{36}\.md$/;

export interface ResolvedInstruction {
  name: string;
  content: string;
}

export interface InstructionRegistry {
  list(): Promise<InstructionEntry[]>;
  views(): Promise<InstructionView[]>;
  read(id: string): Promise<{ entry: InstructionEntry; content: string }>;
  addLinked(path: string, source: InstructionSource): Promise<boolean>;
  save(draft: InstructionDraft): Promise<void>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  resolve(choice: string | null | undefined): Promise<ResolvedInstruction | undefined>;
}

export function normalizedInstructionPath(path: string, platform = process.platform): string {
  return platform === 'win32' ? win32.resolve(path).toLowerCase() : resolve(path);
}

/** Only called for a registered entry or an explicit Main-side import candidate. */
export async function readInstructionFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Instruction path is not a file');
  if (info.size > MAX_BYTES) throw new Error('Instruction file exceeds 2 MiB');
  const content = await readFile(path, 'utf8');
  validateContent(content);
  return content;
}

function validateContent(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES)
    throw new Error('Instruction file exceeds 2 MiB');
  if (content.includes('\0')) throw new Error('Instruction file must be UTF-8 text');
}

export function parseStoredInstruction(raw: unknown): InstructionEntry | null {
  const record = asRecord(raw);
  if (!record || !isRegistryId(record.id) || typeof record.name !== 'string' || !record.name.trim())
    return null;
  if (!SOURCES.includes(record.source as InstructionSource) || typeof record.enabled !== 'boolean')
    return null;
  if (
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt)
  )
    return null;
  const common = {
    id: record.id,
    name: record.name.trim(),
    source: record.source as InstructionSource,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.importedFrom === 'string' ? { importedFrom: record.importedFrom } : {}),
  };
  if (record.kind === 'linked' && typeof record.path === 'string' && isAbsolute(record.path)) {
    return { ...common, kind: 'linked', path: record.path };
  }
  if (
    record.kind === 'local' &&
    typeof record.fileName === 'string' &&
    LOCAL_FILE.test(record.fileName)
  ) {
    return { ...common, kind: 'local', fileName: record.fileName };
  }
  return null;
}

/** All mutations are serialized; content is committed before its metadata pointer changes. */
export function createInstructionRegistry(options: {
  userData: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}): InstructionRegistry {
  const { userData, platform = process.platform, now = Date.now } = options;
  const directory = join(userData, 'instructions');
  const registry = createJsonRegistry<InstructionEntry>({
    filePath: join(userData, 'instructions.json'),
    key: 'instructions',
    parseEntry: parseStoredInstruction,
  });
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
  const list = async () => {
    // Malformed hand-edited metadata must not make two entries active.
    let enabled = false;
    return (await registry.list()).map((entry) => {
      const active = entry.enabled && !enabled;
      enabled ||= active;
      return { ...entry, enabled: active };
    });
  };
  const checkLocalDirectory = async () => {
    // An externally replaced directory must not redirect owned writes or cleanup into user files.
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Instruction copies directory must not be a symbolic link');
  };
  const contentOf = async (entry: InstructionEntry) => {
    if (entry.kind === 'linked') return readInstructionFile(entry.path);
    await checkLocalDirectory();
    const path = join(directory, entry.fileName);
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Instruction copy must not be a symbolic link');
    return readInstructionFile(path);
  };
  const requireEntry = async (id: string) => {
    const entry = (await list()).find((item) => item.id === id);
    if (!entry) throw new Error('Instruction entry no longer exists');
    return entry;
  };
  // Cleanup is limited to generated local filenames. Never pass a linked path here.
  const cleanup = async (fileName: string) => {
    await checkLocalDirectory()
      .then(() => rm(join(directory, fileName), { force: true }))
      .catch(() => undefined);
  };
  return {
    list: () => enqueue(list),
    views: () =>
      enqueue(async () =>
        Promise.all(
          (await list()).map(async (entry) => {
            try {
              const content = await contentOf(entry);
              return {
                ...entry,
                size: Buffer.byteLength(content, 'utf8'),
                charCount: content.length,
              };
            } catch (error) {
              return { ...entry, size: 0, charCount: 0, warning: errorMessage(error) };
            }
          })
        )
      ),
    read: (id) =>
      enqueue(async () => {
        const entry = await requireEntry(id);
        return { entry, content: await contentOf(entry) };
      }),
    addLinked: (path, source) =>
      enqueue(async () => {
        if (!isAbsolute(path) || extname(path).toLowerCase() !== '.md')
          throw new Error('Choose a Markdown (.md) file');
        const entries = await list();
        const normalized = normalizedInstructionPath(path, platform);
        if (
          entries.some((entry) => {
            const origin = entry.kind === 'linked' ? entry.path : entry.importedFrom;
            return origin && normalizedInstructionPath(origin, platform) === normalized;
          })
        )
          return false;
        await readInstructionFile(path);
        const timestamp = now();
        const entry: InstructionEntry = {
          id: randomUUID(),
          name: basename(path),
          source,
          kind: 'linked',
          path: resolve(path),
          enabled: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await registry.transact(() => ({ next: [...entries, entry], result: undefined }));
        return true;
      }),
    save: (draft) =>
      enqueue(async () => {
        const name = draft.name.trim();
        if (!name || name.length > 200)
          throw new Error('Instruction name must contain 1–200 characters');
        validateContent(draft.content);
        const current = draft.id ? await requireEntry(draft.id) : undefined;
        const fileName = `${randomUUID()}.md`;
        const temporary = join(directory, `${fileName}.tmp`);
        await mkdir(directory, { recursive: true });
        await checkLocalDirectory();
        try {
          await writeFile(temporary, draft.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await rename(temporary, join(directory, fileName));
          const timestamp = now();
          const importedFrom = current?.kind === 'linked' ? current.path : current?.importedFrom;
          const entry: InstructionEntry = {
            id: current?.id ?? randomUUID(),
            name,
            source: current?.source ?? 'manual',
            kind: 'local',
            fileName,
            enabled: current?.enabled ?? false,
            ...(importedFrom ? { importedFrom } : {}),
            createdAt: current?.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
          const entries = await list();
          await registry.transact(() => ({
            next: current
              ? entries.map((item) => (item.id === current.id ? entry : item))
              : [...entries, entry],
            result: undefined,
          }));
        } catch (error) {
          await cleanup(`${fileName}.tmp`);
          await cleanup(fileName);
          throw error;
        }
        if (current?.kind === 'local') await cleanup(current.fileName);
      }),
    remove: (id) =>
      enqueue(async () => {
        const entry = await requireEntry(id);
        const entries = await list();
        await registry.transact(() => ({
          next: entries.filter((item) => item.id !== id),
          result: undefined,
        }));
        if (entry.kind === 'local') await cleanup(entry.fileName);
      }),
    setEnabled: (id, enabled) =>
      enqueue(async () => {
        await requireEntry(id);
        const entries = await list();
        await registry.transact(() => ({
          next: entries.map((entry) => ({
            ...entry,
            enabled: entry.id === id ? enabled : enabled ? false : entry.enabled,
            updatedAt: now(),
          })),
          result: undefined,
        }));
      }),
    resolve: (choice) =>
      enqueue(async () => {
        if (choice === null) return undefined;
        const entries = await list();
        const entry =
          choice === undefined
            ? entries.find((item) => item.enabled)
            : entries.find((item) => item.id === choice);
        if (!entry) return undefined;
        try {
          const content = await contentOf(entry);
          return content.trim() ? { name: entry.name, content } : undefined;
        } catch {
          return undefined;
        }
      }),
  };
}
