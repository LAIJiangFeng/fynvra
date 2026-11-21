import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { ChatFileTooLargeError } from '@shared/chatFileText';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAttachments } from './attachments';
import {
  checkZipBomb,
  DOC_WORKER_MEMORY_MB,
  isolatedExtractor,
  MAX_ZIP_ENTRIES,
  type SpawnDocWorker,
} from './docIsolation';

// 假 worker 的脚本（eval 方式，CommonJS）
const ECHO = `require('worker_threads').parentPort.once('message', ({ name }) =>
  require('worker_threads').parentPort.postMessage({ ok: true, file: { name, text: 'ok' } }))`;
const SLOW_ECHO = `require('worker_threads').parentPort.once('message', ({ name }) =>
  setTimeout(() => require('worker_threads').parentPort.postMessage({ ok: true, file: { name, text: 'ok' } }), 50))`;
const HANG = `setInterval(() => {}, 1000)`;
const BUSY = `require('worker_threads').parentPort.once('message', () => { for (;;) {} })`;
const EXIT = `process.exit(3)`;
const THROW = `throw new Error('boom')`;
const OOM = `const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()))`;
const SIZE = `require('worker_threads').parentPort.once('message', () =>
  require('worker_threads').parentPort.postMessage({ ok: false, reason: 'size' }))`;

/** 按顺序取脚本起假 worker；记录起过几个、是否有并发、是否都已终止 */
function fakeSpawn(scripts: string[]) {
  const state = { spawned: 0, active: 0, maxActive: 0, options: [] as WorkerOptions[] };
  const spawn: SpawnDocWorker = (options) => {
    const code = scripts[Math.min(state.spawned, scripts.length - 1)];
    state.spawned++;
    state.options.push(options);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    // 真实上限 512 MB 太慢，测试里压到 32 MB
    const worker = new Worker(code, {
      eval: true,
      ...options,
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    worker.once('exit', () => state.active--);
    return worker;
  };
  return { spawn, state };
}

const PDF = new TextEncoder().encode('%PDF-1.4 fake');

describe('文档解析隔离层', () => {
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

  it('超时就终止 worker、记为 unreadable，下一个文件用新 worker 正常解析', async () => {
    const { spawn, state } = fakeSpawn([BUSY, ECHO]);
    const loaded = await loadAttachments(dataDir, items('a.pdf', 'b.pdf'), (deadline) =>
      isolatedExtractor(deadline, spawn, 300)
    );
    expect(loaded.rejected).toEqual([{ name: 'a.pdf', reason: 'unreadable' }]);
    expect(loaded.files).toEqual([{ name: 'b.pdf', text: 'ok' }]);
    expect(state.spawned).toBe(2);
    expect(state.active).toBe(0);
    expect(state.options[0].resourceLimits?.maxOldGenerationSizeMb).toBe(DOC_WORKER_MEMORY_MB);
  });

  it('worker 崩溃、抛错、内存超限、自行退出都记为 unreadable；抽取器报 size 记为 size', async () => {
    const { spawn, state } = fakeSpawn([EXIT, THROW, OOM, HANG, SIZE]);
    const loaded = await loadAttachments(
      dataDir,
      items('a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'a.pdf'),
      (deadline) => isolatedExtractor(deadline, spawn, 2_000)
    );
    expect(loaded.rejected.map((r) => r.reason)).toEqual([
      'unreadable',
      'unreadable',
      'unreadable',
      'unreadable',
      'size',
    ]);
    expect(state.active).toBe(0);
  }, 20_000);

  it('总预算用完后剩余附件全部 unreadable，且在预算附近返回', async () => {
    const { spawn, state } = fakeSpawn([BUSY]);
    const started = Date.now();
    const loaded = await loadAttachments(
      dataDir,
      items('a.pdf', 'b.pdf', 'c.pdf'),
      (deadline) => isolatedExtractor(deadline, spawn, 15_000),
      400
    );
    const elapsed = Date.now() - started;
    expect(loaded.rejected).toEqual(
      ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => ({ name, reason: 'unreadable' }))
    );
    expect(state.spawned).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('并发调用全局串行：同一时刻最多一个 worker', async () => {
    const { spawn, state } = fakeSpawn([SLOW_ECHO]);
    const make = (deadline: number) => isolatedExtractor(deadline, spawn);
    const results = await Promise.all([
      loadAttachments(dataDir, items('a.pdf', 'b.pdf'), make),
      loadAttachments(dataDir, items('c.pdf', 'd.pdf'), make),
      loadAttachments(dataDir, items('a.pdf'), make),
    ]);
    expect(results.flatMap((r) => r.files)).toHaveLength(5);
    expect(state.spawned).toBe(5);
    expect(state.maxActive).toBe(1);
  });

  it('排队等不到轮次的调用在自己的预算内返回，不阻塞队列', async () => {
    const { spawn, state } = fakeSpawn([BUSY, ECHO]);
    const slow = loadAttachments(dataDir, items('a.pdf'), (d) => isolatedExtractor(d, spawn, 600));
    // 等慢任务占住队列再发第二次调用，避免两次调用抢先后
    await vi.waitFor(() => expect(state.spawned).toBe(1));
    const waiting = await loadAttachments(
      dataDir,
      items('b.pdf'),
      (d) => isolatedExtractor(d, spawn),
      200
    );
    expect(waiting.rejected).toEqual([{ name: 'b.pdf', reason: 'unreadable' }]);
    expect((await slow).rejected).toEqual([{ name: 'a.pdf', reason: 'unreadable' }]);
    const after = await loadAttachments(dataDir, items('c.pdf'), (d) =>
      isolatedExtractor(d, spawn)
    );
    expect(after.files).toEqual([{ name: 'c.pdf', text: 'ok' }]);
    expect(state.spawned).toBe(2);
  });
});

describe('压缩炸弹预检', () => {
  it('声明解压后超过 64 MB 的 docx / xlsx 在解析前就记为 size', async () => {
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(65 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => checkZipBomb(bomb)).toThrow(ChatFileTooLargeError);

    const dataDir = mkdtempSync(join(tmpdir(), 'fynvra-bomb-'));
    try {
      mkdirSync(join(dataDir, 'attachments'));
      writeFileSync(join(dataDir, 'attachments', 'x.docx'), bomb);
      writeFileSync(join(dataDir, 'attachments', 'x.xlsx'), bomb);
      const { spawn, state } = fakeSpawn([ECHO]);
      const loaded = await loadAttachments(
        dataDir,
        [
          { file: 'x.docx', name: 'x.docx' },
          { file: 'x.xlsx', name: 'x.xlsx' },
        ],
        (deadline) => isolatedExtractor(deadline, spawn)
      );
      expect(loaded.rejected.map((r) => r.reason)).toEqual(['size', 'size']);
      expect(state.spawned).toBe(0);
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
