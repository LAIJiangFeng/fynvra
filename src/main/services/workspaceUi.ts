import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord } from '@shared/guards';
import type { WorkspaceFileEntry } from '@shared/types/files';
import {
  emptyWorkspaceUi,
  parseWorkspaceUi,
  workspaceTabKey,
  type WorkspaceUiSnapshot,
} from '@shared/types/workspaceUi';
import type { createFilesService } from './files';

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** One serial queue across workspaces also makes the global storage budget atomic. */
export function createWorkspaceUiService(
  directory: string,
  files: ReturnType<typeof createFilesService>
) {
  let tail: Promise<unknown> = Promise.resolve();
  const remembered = new Map<string, Map<string, WorkspaceFileEntry>>();
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.catch(() => undefined).then(work);
    tail = next;
    return next;
  };
  const filename = (workspaceId: string) => join(directory, `${workspaceId}.json`);
  return {
    selection(workspaceId?: string) {
      return run(async () => {
        const path = join(directory, '.selection.json');
        if (workspaceId === undefined) {
          try {
            if ((await stat(path)).size > 4096) return null;
            const value = asRecord(JSON.parse(await readFile(path, 'utf8')));
            return typeof value?.workspaceId === 'string' ? value.workspaceId : null;
          } catch {
            return null;
          }
        }
        await mkdir(directory, { recursive: true });
        const temporary = join(directory, `${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify({ workspaceId }));
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, path);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
        return workspaceId;
      });
    },
    load(workspaceId: string) {
      return run(async () => {
        await mkdir(directory, { recursive: true });
        let snapshot = emptyWorkspaceUi();
        let warning = false;
        const entries = new Map<string, WorkspaceFileEntry>();
        try {
          const path = filename(workspaceId);
          if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('oversized');
          const stored = asRecord(JSON.parse(await readFile(path, 'utf8')));
          const parsed = parseWorkspaceUi(stored?.snapshot, workspaceId);
          const paths = asRecord(stored?.paths ?? {});
          if (!parsed || !paths) throw new Error('invalid snapshot');
          snapshot = parsed;
          for (const tab of snapshot.tabs) {
            if (tab.kind !== 'file') continue;
            const relativePath = paths[tab.id];
            if (
              typeof relativePath !== 'string' ||
              relativePath.length > 4096 ||
              !relativePath ||
              relativePath.includes('\\') ||
              relativePath.includes(':') ||
              /[\x00-\x1f]/.test(relativePath) ||
              relativePath.split('/').some((p) => !p || p === '.' || p === '..')
            )
              throw new Error('invalid file descriptor');
            const oldKey = workspaceTabKey(tab);
            try {
              tab.entry = await files.restoreEntry(workspaceId, relativePath);
            } catch {
              // An unavailable workspace must not erase its drafts. Reads still fail safely.
              tab.entry = {
                id: tab.id,
                name: relativePath.split('/').pop()!,
                relativePath,
                kind: 'file',
              };
            }
            tab.id = tab.entry.id;
            if (snapshot.active === oldKey) snapshot.active = workspaceTabKey(tab);
            entries.set(tab.id, tab.entry);
          }
          if (!parseWorkspaceUi(snapshot, workspaceId))
            throw new Error('duplicate restored identity');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            // Retain the entire damaged snapshot for recovery; never overwrite it in place.
            await rename(filename(workspaceId), `${filename(workspaceId)}.${Date.now()}.corrupt`);
            warning = true;
          }
          snapshot = emptyWorkspaceUi();
          entries.clear();
        }
        remembered.set(workspaceId, entries);
        return { snapshot, warning };
      });
    },
    save(workspaceId: string, snapshot: WorkspaceUiSnapshot, current: () => boolean) {
      return run(async () => {
        if (!current()) throw new Error('stale snapshot');
        const entries = new Map<string, WorkspaceFileEntry>();
        const paths: Record<string, string> = {};
        for (const tab of snapshot.tabs) {
          if (tab.kind !== 'file') continue;
          let entry: WorkspaceFileEntry;
          try {
            entry = await files.describeEntry(workspaceId, tab.id);
          } catch {
            const previous = remembered.get(workspaceId)?.get(tab.id);
            if (!previous) throw new Error('unknown file id');
            entry = previous;
          }
          paths[tab.id] = entry.relativePath;
          entries.set(tab.id, entry);
        }
        const content = JSON.stringify({ snapshot, paths });
        const bytes = Buffer.byteLength(content);
        if (bytes > MAX_FILE_BYTES) throw new Error('workspace UI size limit');
        await mkdir(directory, { recursive: true });
        let total = bytes;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            entry.name !== `${workspaceId}.json`
          )
            total += (await stat(join(directory, entry.name))).size;
        }
        if (total > MAX_TOTAL_BYTES) throw new Error('workspace UI storage limit');
        const temporary = join(directory, `${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(content, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (!current()) throw new Error('stale snapshot');
          await rename(temporary, filename(workspaceId));
          remembered.set(workspaceId, entries);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      });
    },
    remove(workspaceId: string) {
      return run(async () => {
        remembered.delete(workspaceId);
        await unlink(filename(workspaceId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      });
    },
    async flush() {
      // Individual failures are returned to the caller; a handled, obsolete write must
      // not poison later shutdown after its workspace has already been removed.
      await tail.catch(() => undefined);
    },
  };
}
