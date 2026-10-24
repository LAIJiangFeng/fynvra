import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  base: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
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
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
}));

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

const SECRET = 'ghp_very_secret_token';
const mcpFile = () => readFileSync(join(mocks.base, 'userData', 'mcp.json'), 'utf8');

beforeAll(async () => {
  mocks.base = mkdtempSync(join(tmpdir(), 'fynvra-ipc-mcp-'));
  mkdirSync(join(mocks.base, 'home'));
  writeFileSync(
    join(mocks.base, 'home', '.claude.json'),
    JSON.stringify({
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: SECRET },
        },
        time: { command: 'uvx', args: ['mcp-server-time'] },
      },
      projects: {
        'C:/work/app': {
          mcpServers: {
            remote: {
              type: 'http',
              url: 'https://mcp.example.com/mcp',
              headers: { 'X-Api-Key': SECRET },
            },
          },
        },
      },
    })
  );
  const { registerMcpHandlers } = await import('./mcp');
  registerMcpHandlers();
});

afterAll(() => {
  rmSync(mocks.base, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.send.mockClear();
});

describe('mcp IPC', () => {
  it('upsert 校验入参；保存后 mcp.json 有 env 明文，返回值只有键名', async () => {
    expect(
      await invoke(IPC_CHANNELS.MCP_UPSERT, { name: 'x', transport: 'stdio', enabled: true })
    ).toMatchObject({ ok: false });
    expect(mocks.send).not.toHaveBeenCalled();

    const saved = await invoke(IPC_CHANNELS.MCP_UPSERT, {
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      enabled: true,
      env: [{ key: 'GITHUB_TOKEN', value: SECRET }],
    });
    expect(saved).toMatchObject({ ok: true, server: { id: 'github', envKeys: ['GITHUB_TOKEN'] } });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(mcpFile()).toContain(SECRET);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MCP_CHANGED);
  });

  it('import-claude 合并顶层与项目配置，按命令+参数 / URL 去重，返回值脱敏', async () => {
    const result = await invoke(IPC_CHANNELS.MCP_IMPORT_CLAUDE);
    expect(result).toMatchObject({
      ok: true,
      skipped: 1,
      added: [
        { id: 'time', transport: 'stdio', envKeys: [] },
        {
          id: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headerKeys: ['X-Api-Key'],
        },
      ],
      sources: [
        { status: 'found', count: 3 },
        { status: 'not-found', count: 0 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(await invoke(IPC_CHANNELS.MCP_LIST))).not.toContain(SECRET);

    expect(await invoke(IPC_CHANNELS.MCP_IMPORT_CLAUDE)).toMatchObject({
      ok: true,
      added: [],
      skipped: 3,
    });
  });

  it('toggle / remove 只按 id 操作并广播', async () => {
    for (const raw of [null, { id: 'time' }, { id: 'time', enabled: true, url: 'x' }]) {
      expect(await invoke(IPC_CHANNELS.MCP_TOGGLE, raw)).toMatchObject({ ok: false });
    }
    expect(await invoke(IPC_CHANNELS.MCP_TOGGLE, { id: 'time', enabled: false })).toMatchObject({
      ok: true,
      server: { id: 'time', enabled: false },
    });
    expect(await invoke(IPC_CHANNELS.MCP_REMOVE, 'time')).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenLastCalledWith(IPC_CHANNELS.MCP_CHANGED);
    expect(await invoke(IPC_CHANNELS.MCP_REMOVE, 'time')).toEqual({
      ok: false,
      error: 'MCP 服务器不存在',
    });
  });
});
