import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  base: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, homedir: () => join(mocks.base, 'home') };
});

vi.mock('electron', () => ({
  app: { getPath: () => join(mocks.base, 'userData'), on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
  dialog: { showOpenDialog: mocks.showOpenDialog },
}));

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

const pick = (dir: string | null) =>
  mocks.showOpenDialog.mockResolvedValueOnce(
    dir ? { canceled: false, filePaths: [dir] } : { canceled: true, filePaths: [] }
  );

const makeSkill = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
  return dir;
};

beforeAll(async () => {
  mocks.base = mkdtempSync(join(tmpdir(), 'fynvra-ipc-skills-'));
  makeSkill(join(mocks.base, 'home', '.claude', 'skills', 'pdf'), 'pdf');
  makeSkill(join(mocks.base, 'home', '.pi', 'agent', 'skills', 'pdf'), 'PDF');
  const { registerSkillHandlers } = await import('./skills');
  registerSkillHandlers();
});

afterAll(() => {
  rmSync(mocks.base, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.send.mockClear();
});

describe('skills IPC', () => {
  it('scan 列出本机技能（按名称去重），各来源给出状态，只读不登记', async () => {
    const result = await invoke(IPC_CHANNELS.SKILLS_SCAN);
    expect(result).toMatchObject({
      ok: true,
      candidates: [{ id: 'claude:pdf', name: 'pdf', registered: false }],
      sources: [
        { source: 'claude', status: 'found', count: 1 },
        { source: 'codex', status: 'not-found', count: 0 },
        { source: 'pi', status: 'found', count: 1 },
      ],
    });
    expect(await invoke(IPC_CHANNELS.SKILLS_LIST)).toEqual({ ok: true, skills: [] });
  });

  it('add 登记扫描结果：只收候选 id，路径由 Main 拼出', async () => {
    for (const raw of [
      'claude:pdf',
      { candidateIds: [] },
      { candidateIds: ['claude:../../etc'] },
      { candidateIds: ['claude:pdf'], path: '/x' },
    ]) {
      expect(await invoke(IPC_CHANNELS.SKILLS_ADD, raw)).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    }

    const result = await invoke(IPC_CHANNELS.SKILLS_ADD, {
      candidateIds: ['claude:pdf', 'codex:gone'],
    });
    expect(result).toMatchObject({
      ok: true,
      skills: [{ id: 'pdf', name: 'pdf', description: 'pdf skill', enabled: true }],
      skipped: [expect.stringContaining('SKILL.md')],
    });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.SKILLS_CHANGED);
    const disk = JSON.parse(readFileSync(join(mocks.base, 'userData', 'skills.json'), 'utf8'));
    expect(disk.skills[0].path).toBe(join(mocks.base, 'home', '.claude', 'skills', 'pdf'));

    expect(await invoke(IPC_CHANNELS.SKILLS_SCAN)).toMatchObject({
      candidates: [{ id: 'claude:pdf', registered: true }],
    });
  });

  it('add 无参时弹目录框：取消、缺 SKILL.md、重复、成功各自返回', async () => {
    pick(null);
    expect(await invoke(IPC_CHANNELS.SKILLS_ADD)).toMatchObject({ ok: false, code: 'canceled' });

    const empty = join(mocks.base, 'empty');
    mkdirSync(empty);
    pick(empty);
    expect(await invoke(IPC_CHANNELS.SKILLS_ADD)).toMatchObject({ ok: false, code: 'invalid' });

    const web = makeSkill(join(mocks.base, 'web-skill'), 'web');
    pick(web);
    expect(await invoke(IPC_CHANNELS.SKILLS_ADD)).toMatchObject({
      ok: true,
      skills: [{ id: 'web', path: web }],
    });
    pick(web);
    expect(await invoke(IPC_CHANNELS.SKILLS_ADD)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('toggle / remove 只按 id 操作并广播', async () => {
    for (const raw of [
      null,
      { id: 'web' },
      { id: 'web', enabled: 'no' },
      { id: '../x', enabled: true },
    ]) {
      expect(await invoke(IPC_CHANNELS.SKILLS_TOGGLE, raw)).toMatchObject({ ok: false });
    }
    expect(await invoke(IPC_CHANNELS.SKILLS_TOGGLE, { id: 'web', enabled: false })).toMatchObject({
      ok: true,
      skill: { id: 'web', enabled: false },
    });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.SKILLS_CHANGED);

    expect(await invoke(IPC_CHANNELS.SKILLS_REMOVE, 'web')).toEqual({ ok: true });
    expect(await invoke(IPC_CHANNELS.SKILLS_REMOVE, 'web')).toEqual({
      ok: false,
      error: '技能不存在',
    });
  });
});
