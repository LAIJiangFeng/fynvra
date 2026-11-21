import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatFileTooLargeError } from '@shared/chatFileText';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_WHITELIST } from '../appPlugins/runtime';
import { loadAttachments } from './attachments';
import {
  checkZipBomb,
  type ForkParser,
  type IsolationOptions,
  isolatedExtractor,
  MAX_ZIP_ENTRIES,
  type MemoryOfPid,
} from './docIsolation';

type Behavior = 'echo' | 'slowEcho' | 'hang' | 'exit' | 'size' | 'garbage';

/** 按顺序取行为的假子进程；记录 fork 次数、并发数、kill 次数和 env */
function fakeFork(behaviors: Behavior[]) {
  const state = {
    forked: 0,
    active: 0,
    maxActive: 0,
    killed: 0,
    envs: [] as Record<string, string>[],
  };
  const fork: ForkParser = ({ env }) => {
    const behavior = behaviors[Math.min(state.forked, behaviors.length - 1)];
    const pid = 1000 + state.forked;
    state.forked++;
    state.envs.push(env);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const messageListeners: ((message: unknown) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];
    let alive = true;
    const exit = (code: number) => {
      if (!alive) return;
      alive = false;
      state.active--;
      for (const listener of exitListeners) listener(code);
    };
    const reply = (message: unknown, ms = 0) =>
      setTimeout(() => {
        if (alive) for (const listener of messageListeners) listener(message);
      }, ms);
    return {
      pid,
      postMessage(message) {
        const { name } = message as { name: string };
        if (behavior === 'echo') reply({ ok: true, file: { name, text: 'ok' } });
        if (behavior === 'slowEcho') reply({ ok: true, file: { name, text: 'ok' } }, 50);
        if (behavior === 'exit') setTimeout(() => exit(3), 0);
        if (behavior === 'size') reply({ ok: false, reason: 'size' });
        if (behavior === 'garbage') reply({ ok: true, file: { text: 1 } });
      },
      onMessage: (listener) => messageListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
      kill() {
        state.killed++;
        setTimeout(() => exit(-1), 0);
      },
    };
  };
  return { fork, state };
}

const quietMemory: MemoryOfPid = () => 10 * 1024;
const PDF = new TextEncoder().encode('%PDF-1.4 fake');

describe('附件解析隔离层', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'fynvra-iso-'));
    mkdirSync(join(dataDir, 'attachments'));
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']) {
      writeFileSync(join(dataDir, 'attachments', name), PDF);
    }
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const items = (...names: string[]) => names.map((name) => ({ file: name, name }));
  const using =
    (fork: ForkParser, options: IsolationOptions = {}) =>
    (deadline: number) =>
      isolatedExtractor(deadline, { fork, memoryOf: quietMemory, ...options });

  it('超时就 kill 子进程、记为 unreadable，下一个文件用新进程正常解析', async () => {
    const { fork, state } = fakeFork(['hang', 'echo']);
    const loaded = await loadAttachments(
      dataDir,
      items('a.pdf', 'b.pdf'),
      using(fork, { fileTimeoutMs: 200 })
    );
    expect(loaded.rejected).toEqual([{ name: 'a.pdf', reason: 'unreadable' }]);
    expect(loaded.files).toEqual([{ name: 'b.pdf', text: 'ok' }]);
    expect(state.forked).toBe(2);
    expect(state.killed).toBe(2);
    expect(state.active).toBe(0);
  });

  it('子进程退出、回传形状不对都记为 unreadable；解析器报 size 记为 size', async () => {
    const { fork, state } = fakeFork(['exit', 'garbage', 'size']);
    const loaded = await loadAttachments(dataDir, items('a.pdf', 'b.pdf', 'c.pdf'), using(fork));
    expect(loaded.rejected.map((r) => r.reason)).toEqual(['unreadable', 'unreadable', 'size']);
    expect(state.active).toBe(0);
  });

  it('内存看门狗：超过上限立即 kill，记为 unreadable，下一个文件正常', async () => {
    const { fork, state } = fakeFork(['hang', 'echo']);
    const memoryOf: MemoryOfPid = (pid) => (pid === 1000 ? 2 * 1024 * 1024 : 10 * 1024);
    const started = Date.now();
    const loaded = await loadAttachments(
      dataDir,
      items('a.pdf', 'b.pdf'),
      using(fork, { memoryOf, fileTimeoutMs: 10_000 })
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(loaded.rejected).toEqual([{ name: 'a.pdf', reason: 'unreadable' }]);
    expect(loaded.files).toEqual([{ name: 'b.pdf', text: 'ok' }]);
    expect(state.killed).toBe(2);
  });

  it('fork 时 env 只有白名单变量，不带 Main 的令牌', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_fake_should_not_leak');
    try {
      const { fork, state } = fakeFork(['echo']);
      await loadAttachments(dataDir, items('a.pdf'), using(fork));
      const env = state.envs[0];
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain('ghp_fake_should_not_leak');
      for (const key of Object.keys(env)) {
        expect(ENV_WHITELIST.map((k) => k.toLowerCase())).toContain(key.toLowerCase());
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('总预算用完后剩余附件全部 unreadable，且在预算附近返回', async () => {
    const { fork, state } = fakeFork(['hang']);
    const started = Date.now();
    const loaded = await loadAttachments(
      dataDir,
      items('a.pdf', 'b.pdf', 'c.pdf'),
      using(fork, { fileTimeoutMs: 15_000 }),
      400
    );
    const elapsed = Date.now() - started;
    expect(loaded.rejected).toEqual(
      ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => ({ name, reason: 'unreadable' }))
    );
    expect(state.forked).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('并发调用全局串行：同一时刻最多一个子进程', async () => {
    const { fork, state } = fakeFork(['slowEcho']);
    const make = using(fork);
    const results = await Promise.all([
      loadAttachments(dataDir, items('a.pdf', 'b.pdf'), make),
      loadAttachments(dataDir, items('c.pdf', 'd.pdf'), make),
      loadAttachments(dataDir, items('a.pdf'), make),
    ]);
    expect(results.flatMap((r) => r.files)).toHaveLength(5);
    expect(state.forked).toBe(5);
    expect(state.maxActive).toBe(1);
  });

  it('排队等不到轮次的调用在自己的预算内返回，不阻塞队列', async () => {
    const { fork, state } = fakeFork(['hang', 'echo']);
    const slow = loadAttachments(dataDir, items('a.pdf'), using(fork, { fileTimeoutMs: 600 }));
    // 等慢任务占住队列再发第二次调用，避免两次调用抢先后
    await vi.waitFor(() => expect(state.forked).toBe(1));
    const waiting = await loadAttachments(dataDir, items('b.pdf'), using(fork), 200);
    expect(waiting.rejected).toEqual([{ name: 'b.pdf', reason: 'unreadable' }]);
    expect((await slow).rejected).toEqual([{ name: 'a.pdf', reason: 'unreadable' }]);
    const after = await loadAttachments(dataDir, items('c.pdf'), using(fork));
    expect(after.files).toEqual([{ name: 'c.pdf', text: 'ok' }]);
    expect(state.forked).toBe(2);
  });
});

describe('压缩炸弹预检', () => {
  it('声明解压后超过 64 MB 的 docx / xlsx 在解析前就记为 size', async () => {
    // 小 zip，只把中央目录里声明的解压后大小改成 65 MB（checkZipBomb 读的就是声明值）
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(16) });
    const view = new DataView(bomb.buffer);
    const central = bomb.findIndex((_, i) => view.getUint32(i, true) === 0x02014b50);
    view.setUint32(central + 24, 65 * 1024 * 1024, true);
    expect(() => checkZipBomb(zipSync({ 'word/document.xml': new Uint8Array(16) }))).not.toThrow();
    expect(() => checkZipBomb(bomb)).toThrow(ChatFileTooLargeError);

    const dataDir = mkdtempSync(join(tmpdir(), 'fynvra-bomb-'));
    try {
      mkdirSync(join(dataDir, 'attachments'));
      writeFileSync(join(dataDir, 'attachments', 'x.docx'), bomb);
      writeFileSync(join(dataDir, 'attachments', 'x.xlsx'), bomb);
      const { fork, state } = fakeFork(['echo']);
      const loaded = await loadAttachments(
        dataDir,
        [
          { file: 'x.docx', name: 'x.docx' },
          { file: 'x.xlsx', name: 'x.xlsx' },
        ],
        (deadline) => isolatedExtractor(deadline, { fork, memoryOf: quietMemory })
      );
      expect(loaded.rejected.map((r) => r.reason)).toEqual(['size', 'size']);
      expect(state.forked).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('条目数超过上限的拒绝，正常 zip 放行', () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) many[`f${i}.xml`] = new Uint8Array(0);
    expect(() => checkZipBomb(zipSync(many))).toThrow(ChatFileTooLargeError);
    expect(() => checkZipBomb(zipSync({ 'a.xml': new Uint8Array(10) }))).not.toThrow();
  });
});
