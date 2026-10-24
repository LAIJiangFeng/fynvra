import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionStore,
  parseSessionId,
  parseSessionsFile,
  type StoredSession,
} from './sessionStore';

function session(patch: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    roleId: 'worker',
    title: 'Worker',
    cwd: 'C:\\repos\\demo',
    status: 'idle',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...patch,
  };
}

let dir = '';
let filePath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-sessions-'));
  filePath = join(dir, 'sessions.json');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const readDisk = () => JSON.parse(readFileSync(filePath, 'utf8'));

describe('parseSessionId', () => {
  it.each(['session-1', 'a', 'f3b2c1d0-1234-4abc-8def-0123456789ab', 'x_y'])('accepts %j', (id) => {
    expect(parseSessionId(id)).toBe(id);
  });

  it.each([42, '', null, '../sessions.json', 'C:\\x', 'a b', 'a'.repeat(65), 'a.jsonl'])(
    'rejects %j',
    (raw) => {
      expect(parseSessionId(raw)).toBeNull();
    }
  );
});

describe('parseSessionsFile', () => {
  it('returns no sessions for missing, corrupt or foreign data', () => {
    expect(parseSessionsFile(undefined)).toEqual([]);
    expect(parseSessionsFile('nope')).toEqual([]);
    expect(parseSessionsFile({ sessions: 'nope' })).toEqual([]);
  });

  it('keeps valid records, drops invalid and duplicate ones, and strips unknown fields', () => {
    const valid = session({
      worktreeId: 'wt_1',
      dispatchId: 'dsp_1',
      parentSessionId: 'session-0',
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
      autoTitle: true,
    });
    const parsed = parseSessionsFile({
      version: 1,
      sessions: [
        { ...valid, apiKey: 'sk-should-not-survive' },
        { ...valid, title: 'duplicate id' },
        session({ id: '../evil' }),
        session({ id: 'no-role', roleId: 'Not A Slug' }),
        session({ id: 'no-cwd', cwd: '' }),
        session({ id: 'bad-status', status: 'busy' as never }),
        session({ id: 'bad-time', createdAt: Number.NaN }),
        session({ id: 'bad-model', model: { providerId: 'x' } as never }),
        null,
      ],
    });
    expect(parsed).toEqual([valid]);
  });

  it('resets statuses that cannot outlive the previous app run', () => {
    const parsed = parseSessionsFile({
      sessions: [
        session({ id: 'a', status: 'running' }),
        session({ id: 'b', status: 'waiting-approval' }),
        session({ id: 'c', status: 'error' }),
      ],
    });
    expect(parsed.map((entry) => entry.status)).toEqual(['idle', 'idle', 'error']);
  });
});

describe('createSessionStore', () => {
  it('starts empty without a file and lists sessions of one workspace, newest first', () => {
    const store = createSessionStore({ filePath });
    expect(store.list('ws-1')).toEqual([]);
    store.put(session({ id: 'old', updatedAt: 1 }));
    store.put(session({ id: 'new', updatedAt: 5, autoTitle: true }));
    store.put(session({ id: 'other', workspaceId: 'ws-2' }));
    expect(store.list('ws-1').map((entry) => entry.id)).toEqual(['new', 'old']);
    // 内部字段不进 IPC 视图
    expect(store.list('ws-1')[0]).not.toHaveProperty('autoTitle');
    expect(store.get('new')?.autoTitle).toBe(true);
  });

  it('merges updates and removes records', () => {
    const store = createSessionStore({ filePath });
    store.put(session());
    expect(store.update('session-1', { status: 'running', updatedAt: 9 })).toMatchObject({
      status: 'running',
      updatedAt: 9,
      title: 'Worker',
    });
    expect(store.update('missing', { status: 'idle' })).toBeUndefined();
    expect(store.remove('session-1')?.id).toBe('session-1');
    expect(store.remove('session-1')).toBeUndefined();
    expect(store.list('ws-1')).toEqual([]);
  });

  it('loads what an earlier store wrote', () => {
    const first = createSessionStore({ filePath });
    first.put(session({ autoTitle: true }));
    expect(first.flush()).toBe(true);
    const second = createSessionStore({ filePath });
    expect(second.get('session-1')).toEqual(session({ autoTitle: true }));
  });

  it('debounces writes and replaces the file atomically', () => {
    vi.useFakeTimers();
    const store = createSessionStore({ filePath, debounceMs: 200 });
    store.put(session({ id: 'a' }));
    store.put(session({ id: 'b' }));
    expect(existsSync(filePath)).toBe(false);
    vi.advanceTimersByTime(200);
    expect(readDisk()).toEqual({
      version: 1,
      sessions: [session({ id: 'a' }), session({ id: 'b' })],
    });
    expect(readdirSync(dir)).toEqual(['sessions.json']);
  });

  it('keeps pending changes when a write fails and retries on the next flush', () => {
    mkdirSync(filePath);
    const store = createSessionStore({ filePath });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.put(session());
    expect(store.flush()).toBe(false);
    expect(errors).toHaveBeenCalled();
    rmSync(filePath, { recursive: true });
    expect(store.flush()).toBe(true);
    expect(readDisk().sessions).toHaveLength(1);
    errors.mockRestore();
  });

  it('ignores a corrupt file and overwrites it on the next write', () => {
    writeFileSync(filePath, '{ not json');
    const store = createSessionStore({ filePath });
    expect(store.list('ws-1')).toEqual([]);
    store.put(session());
    store.flush();
    expect(readDisk().sessions).toHaveLength(1);
  });
});
