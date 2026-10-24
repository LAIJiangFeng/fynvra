import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeExec } from './nodeExec';
import { createShellRunner } from './shellRunner';

// 真实子进程；Windows 上起 cmd + node 较慢
const TEST_TIMEOUT = 30_000;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-shell-'));
  writeFileSync(join(dir, 'marker.txt'), 'here');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createShellRunner', () => {
  const run = createShellRunner();

  it('在 cwd 里经 shell 执行，透传退出码，stdout 与 stderr 合并', {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const ok = await run(dir, "node -e \"console.log(require('fs').existsSync('marker.txt'))\"");
    expect(ok).toMatchObject({ exitCode: 0, output: expect.stringContaining('true') });
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);

    const failed = await run(dir, 'node -e "console.error(\'oops\'); process.exit(3)"');
    expect(failed).toMatchObject({ exitCode: 3, output: expect.stringContaining('oops') });

    const chained = await run(dir, 'node -e "console.log(1)" && node -e "console.log(2)"');
    expect(chained.output.replace(/\r/g, '')).toBe('1\n2\n');
  });

  it('超时结束整个进程树，exitCode 为 -1 并注明原因', { timeout: TEST_TIMEOUT }, async () => {
    const slow = createShellRunner({ timeoutMs: 500 });
    const started = Date.now();
    const result = await slow(dir, 'node -e "setTimeout(() => {}, 60000)"');
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('signal 中止时尽快结束', { timeout: TEST_TIMEOUT }, async () => {
    const controller = new AbortController();
    const running = run(dir, 'node -e "setTimeout(() => {}, 60000)"', controller.signal);
    setTimeout(() => controller.abort(), 300);
    const result = await running;
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain('aborted');

    const aborted = new AbortController();
    aborted.abort();
    expect(await run(dir, 'node --version', aborted.signal)).toMatchObject({ exitCode: -1 });
  });

  it('只保留输出尾部', { timeout: TEST_TIMEOUT }, async () => {
    const short = createShellRunner({ outputLimit: 100 });
    const result = await short(dir, "node -e \"process.stdout.write('x'.repeat(5000) + 'END')\"");
    expect(result.output.length).toBe(100);
    expect(result.output.endsWith('END')).toBe(true);
  });

  it('cwd 不存在时返回失败结果而不是抛异常', { timeout: TEST_TIMEOUT }, async () => {
    const result = await run(join(dir, 'missing'), 'node --version');
    expect(result.exitCode).not.toBe(0);
  });
});

describe('nodeExec', () => {
  it('不经 shell 执行；非零退出码 resolve，起不来时 reject', {
    timeout: TEST_TIMEOUT,
  }, async () => {
    expect(await nodeExec('node', ['-e', 'process.exit(3)'], dir)).toMatchObject({ code: 3 });
    const version = await nodeExec('node', ['--version'], dir);
    expect(version).toMatchObject({ code: 0, stdout: expect.stringMatching(/^v\d+/) });
    await expect(nodeExec('fynvra-no-such-command', [], dir)).rejects.toThrow();
  });
});
