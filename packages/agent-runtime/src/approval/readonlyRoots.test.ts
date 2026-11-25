import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApprovalMode, SessionProfile } from '@fynvra/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApprovalRequestFn, createApprovalGate } from './gate';
import { insideReadonlyRoot } from './profilePolicy';

// 聊天附件副本目录：对 agent 只读（读文件 / 搜索可读，改文件的工具一律拦下）
let root: string;
let cwd: string;
let copies: string;
let copy: string;
let outside: string;
let linked = false;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fynvra-readonly-roots-'));
  cwd = path.join(root, 'repo');
  copies = path.join(root, 'session-attachments', 's-1');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(copies, { recursive: true });
  fs.mkdirSync(outside);
  copy = path.join(copies, 'ab12-serial.log');
  fs.writeFileSync(copy, 'boot\nready\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  try {
    // Windows 上没有权限时建不了符号链接，相关用例跳过
    fs.symlinkSync(outside, path.join(copies, 'escape'), 'junction');
    linked = true;
  } catch {
    linked = false;
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(mode: ApprovalMode, profile?: SessionProfile) {
  const request = vi.fn<ApprovalRequestFn>(async () => 'allowSession');
  const gate = createApprovalGate({
    mode,
    request,
    cwd,
    readonlyRoots: [copies],
    ...(profile ? { profile: () => profile } : {}),
  });
  const check = (toolName: string, input: unknown) =>
    gate.check({ toolCallId: 'c', toolName, input });
  return { request, check };
}

describe('insideReadonlyRoot', () => {
  it('按解析后的路径判定，lenient 时也认 pi 的 @ 前缀与 file://', async () => {
    expect(await insideReadonlyRoot([copies], cwd, copy, false)).toBe(true);
    expect(await insideReadonlyRoot([copies], cwd, path.join(cwd, 'src'), false)).toBe(false);
    expect(await insideReadonlyRoot([copies], cwd, `@${copy}`, false)).toBe(false);
    expect(await insideReadonlyRoot([copies], cwd, `@${copy}`, true)).toBe(true);
    expect(await insideReadonlyRoot([copies], cwd, pathToFileURL(copy).href, true)).toBe(true);
    expect(await insideReadonlyRoot([], cwd, copy, true)).toBe(false);
  });

  it('链接指向根外的不算在根内（放行读取时）', async (ctx) => {
    if (!linked) ctx.skip();
    const target = path.join(copies, 'escape', 'secret.txt');
    expect(await insideReadonlyRoot([copies], cwd, target, false)).toBe(false);
    expect(await insideReadonlyRoot([copies], cwd, target, true)).toBe(true);
  });
});

describe('approval gate: read-only roots', () => {
  it.each<ApprovalMode>(['supervised', 'auto-edits', 'full'])(
    '%s 档：写 / 改副本目录里的文件一律拒绝，不问人',
    async (mode) => {
      const env = setup(mode);
      for (const [tool, input] of [
        ['write', { path: copy, content: 'x' }],
        ['edit', { path: copy, edits: [] }],
        ['write', { path: path.join(copies, 'new.txt'), content: 'x' }],
        ['write', { path: `@${copy}`, content: 'x' }],
        ['apply_patch', { input: `*** Update File: ${copy}\n` }],
      ] as const) {
        const result = await env.check(tool, input);
        expect(result?.reason, `${tool} ${JSON.stringify(input)}`).toContain(
          'read-only attachment copy'
        );
      }
      expect(env.request).not.toHaveBeenCalled();
    }
  );

  it('读副本不需要审批；工作区里的写入照原档位处理', async () => {
    const env = setup('full');
    expect(await env.check('read', { path: copy })).toBeUndefined();
    expect(await env.check('grep', { pattern: 'boot', path: copies })).toBeUndefined();
    expect(await env.check('write', { path: 'src/a.ts', content: 'x' })).toBeUndefined();
  });

  it.each<SessionProfile>(['triage', 'restricted'])(
    '%s 会话可以读副本目录，但仍不能写，其他工作目录外的路径照旧拒绝',
    async (profile) => {
      const env = setup('supervised', profile);
      expect(await env.check('read', { path: copy })).toBeUndefined();
      expect(await env.check('grep', { pattern: 'boot', path: copies })).toBeUndefined();
      expect(await env.check('ls', { path: copies })).toBeUndefined();
      expect((await env.check('write', { path: copy, content: 'x' }))?.reason).toContain(
        'read-only'
      );
      expect(
        (await env.check('read', { path: path.join(outside, 'secret.txt') }))?.reason
      ).toContain('outside the working directory');
      expect((await env.check('read', { path: `@${copy}` }))?.reason).toBeDefined();
    }
  );
});
