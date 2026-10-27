import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageContext } from './aggregate';
import { readUsageFile, UsageService } from './service';

const now = new Date(2026, 3, 3, 12).getTime();
const message = `${JSON.stringify({ type: 'message', message: { role: 'user', timestamp: now } })}\n`;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(process.cwd(), '.usage-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('usage file service', () => {
  it('streams malformed and valid lines, includes unlisted sessions and ignores non-jsonl entries', async () => {
    await writeFile(
      join(directory, 'deleted-session.jsonl'),
      `malformed\r\n${message}${message}{"partial":`
    );
    await writeFile(join(directory, 'archived-session.jsonl'), message);
    await writeFile(join(directory, 'ignored.txt'), message);
    await mkdir(join(directory, 'directory.jsonl'));
    const service = new UsageService(directory, readUsageFile, () => now);
    const result = await service.summary('today');
    expect(result.current.totals).toMatchObject({ messages: 3, sessions: 2 });
    expect(await readUsageFile(join(directory, 'missing.jsonl'))).toBeNull();
    expect(await readUsageFile(join(directory, 'directory.jsonl'))).toBeNull();
  });

  it('caches by path, mtime and size; only rereads changes and prunes removed files', async () => {
    const a = join(directory, 'a.jsonl');
    const b = join(directory, 'b.jsonl');
    await writeFile(a, message);
    await writeFile(b, message);
    const read = vi.fn(readUsageFile);
    const service = new UsageService(directory, read, () => now);
    await service.summary('today');
    expect(read).toHaveBeenCalledTimes(2);
    await service.summary('7d');
    expect(read).toHaveBeenCalledTimes(2);
    const original = await stat(a);
    await utimes(a, original.atime, new Date(original.mtimeMs + 10_000));
    await service.summary('today');
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith(a);
    // Even with an unchanged mtime, size changes invalidate the cached aggregate.
    const changed = await stat(a);
    await appendFile(a, message);
    await utimes(a, changed.atime, changed.mtime);
    expect((await service.summary('today')).current.totals.messages).toBe(3);
    expect(read).toHaveBeenCalledTimes(4);
    await rm(b);
    expect((await service.summary('today')).current.totals.sessions).toBe(1);
    expect(read).toHaveBeenCalledTimes(4);
    await writeFile(b, message);
    expect((await service.summary('today')).current.totals.sessions).toBe(2);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('coalesces concurrent scans and retries failed files without losing good ones', async () => {
    const a = join(directory, 'a.jsonl');
    const b = join(directory, 'b.jsonl');
    await writeFile(a, message);
    await writeFile(b, message);
    let fail = true;
    const read = vi.fn(async (path: string) => {
      if (path === a && fail) throw new Error('unreadable file');
      return readUsageFile(path);
    });
    const service = new UsageService(directory, read, () => now);
    const [today, week] = await Promise.all([service.summary('today'), service.summary('7d')]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(today.current.totals.messages).toBe(1);
    expect(week.current.totals.messages).toBe(1);
    fail = false;
    expect((await service.summary('today')).current.totals.messages).toBe(2);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('refreshes registry metadata and snapshots without rereading cached transcripts', async () => {
    await writeFile(join(directory, 'worker.jsonl'), message);
    const context: UsageContext = {
      sessions: [{ id: 'worker', roleId: 'worker', workspaceId: 'ws' }],
      workspaces: [{ id: 'ws', name: 'Original' }],
      snapshots: [],
    };
    const getContext = vi.fn(async () => context);
    const read = vi.fn(readUsageFile);
    const service = new UsageService(directory, read, () => now, getContext);
    expect((await service.summary('today')).byRole[0]).toMatchObject({
      roleId: 'worker',
      sessions: 1,
    });
    context.sessions = [{ id: 'worker', roleId: 'reviewer', workspaceId: 'ws' }];
    context.workspaces = [{ id: 'ws', name: 'Renamed' }];
    const changed = await service.summary('today');
    expect(changed.byRole[0].roleId).toBe('reviewer');
    expect(changed.byWorkspace[0].name).toBe('Renamed');
    context.sessions = [];
    const deleted = await service.summary('today');
    expect(deleted.byRole[0].roleId).toBeNull();
    expect(deleted.byWorkspace[0].name).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledTimes(3);
  });

  it('returns an empty summary before the sessions directory exists', async () => {
    const service = new UsageService(join(directory, 'not-created'), readUsageFile, () => now);
    expect((await service.summary('7d')).current.totals.messages).toBe(0);
  });
});
