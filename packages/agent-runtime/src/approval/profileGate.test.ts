import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalMode, SessionProfile } from '@fynvra/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApprovalRequestFn, createApprovalGate } from './gate';
import { filterSensitiveResults } from './profilePolicy';

let root: string;
let cwd: string;
let outside: string;
let linked = false;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fynvra-profile-gate-'));
  cwd = path.join(root, 'repo');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), '');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  try {
    // Windows 上没有权限时建不了符号链接，相关用例跳过
    fs.symlinkSync(outside, path.join(cwd, 'escape'), 'junction');
    linked = true;
  } catch {
    linked = false;
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(mode: ApprovalMode = 'supervised', profile: SessionProfile = 'restricted') {
  const request = vi.fn<ApprovalRequestFn>(async () => 'allow');
  const gate = createApprovalGate({ mode, request, profile: () => profile, cwd });
  const check = (toolName: string, input: unknown) =>
    gate.check({ toolCallId: 'c', toolName, input });
  return { gate, request, check };
}

const write = (target: string) => ['write', { path: target, content: 'x' }] as const;
const read = (target: string) => ['read', { path: target }] as const;
const bash = (command: string) => ['bash', { command }] as const;

describe('approval gate: restricted profile', () => {
  it('refuses reads and writes outside the working directory', async () => {
    const env = setup();
    for (const [tool, input] of [
      read(path.join(outside, 'secret.txt')),
      write(path.join(outside, 'new.txt')),
      read('../outside/secret.txt'),
      write('../outside/new.txt'),
      ['grep', { pattern: 'x', path: '..' }] as const,
      ['ls', { path: outside }] as const,
    ]) {
      const result = await env.check(tool, input);
      expect(result?.reason).toContain(
        'restricted session: path outside the working directory is not allowed'
      );
    }
    expect(env.request).not.toHaveBeenCalled();
  });

  it('refuses a symbolic link inside the working directory that points outside', async (ctx) => {
    if (!linked) ctx.skip(); // 本机不允许创建符号链接 / junction
    const env = setup();
    expect((await env.check(...read('escape/secret.txt')))?.reason).toContain('outside');
    expect((await env.check(...write('escape/new.txt')))?.reason).toContain('outside');
  });

  it('refuses sensitive files for reading and protected paths for writing', async () => {
    const env = setup();
    expect((await env.check(...read('.env')))?.reason).toContain('sensitive file');
    expect((await env.check(...read('config/id_rsa')))?.reason).toContain('sensitive file');
    expect((await env.check(...write('package.json')))?.reason).toContain('protected');
    expect((await env.check(...write('.github/workflows/x.yml')))?.reason).toContain('protected');
    expect((await env.check('edit', { path: 'tsconfig.json', edits: [] }))?.reason).toContain(
      'protected'
    );
    expect(
      (await env.check('apply_patch', { input: '*** Delete File: pnpm-lock.yaml\n' }))?.reason
    ).toContain('protected');
    expect(env.request).not.toHaveBeenCalled();
  });

  it('allows writing project files and reading inside the working directory without asking', async () => {
    const env = setup('supervised');
    expect(await env.check(...write('src/a.ts'))).toBeUndefined();
    expect(await env.check(...write('src/new/b.ts'))).toBeUndefined();
    expect(await env.check('edit', { path: 'src/a.ts', edits: [] })).toBeUndefined();
    expect(await env.check(...read('src/a.ts'))).toBeUndefined();
    expect(await env.check('grep', { pattern: 'x' })).toBeUndefined();
    expect(await env.check('find', { pattern: '*.ts' })).toBeUndefined();
    expect(await env.check('ls', {})).toBeUndefined();
    expect(env.request).not.toHaveBeenCalled();
  });

  it('runs only whitelisted commands, without asking in any approval mode', async () => {
    for (const mode of ['supervised', 'auto-edits', 'full'] as const) {
      const env = setup(mode);
      for (const command of ['curl x', 'pnpm test', 'git commit -m x', 'git push']) {
        expect((await env.check(...bash(command)))?.reason).toMatch(/^restricted session: /);
      }
      expect(await env.check(...bash('git commit --no-verify -m x'))).toBeUndefined();
      expect(await env.check(...bash('pnpm lint'))).toBeUndefined();
      expect(await env.check('powershell', { command: 'pnpm typecheck' })).toBeUndefined();
      expect(env.request).not.toHaveBeenCalled();
    }
  });

  it('checks run_checks against the checks whitelist', async () => {
    const env = setup();
    expect(
      (await env.check('run_checks', { dispatch_id: 'd', command: 'pnpm test --run' }))?.reason
    ).toMatch(/^restricted session: /);
    expect(
      await env.check('run_checks', { dispatch_id: 'd', command: 'pnpm typecheck' })
    ).toBeUndefined();
    expect(
      await env.check('run_checks', { dispatch_id: 'd', command: 'pnpm lint' })
    ).toBeUndefined();
    expect(env.request).not.toHaveBeenCalled();
  });

  it('runs run_checks pnpm test right away without asking in a restricted session', async () => {
    for (const mode of ['supervised', 'full'] as const) {
      const env = setup(mode);
      expect(
        await env.check('run_checks', { dispatch_id: 'd', command: 'pnpm test' })
      ).toBeUndefined();
      expect(env.request).not.toHaveBeenCalled();
    }
  });

  it('refuses pnpm test in a triage session without asking', async () => {
    const env = setup('full', 'triage');
    expect(
      (await env.check('run_checks', { dispatch_id: 'd', command: 'pnpm test' }))?.reason
    ).toMatch(/^triage session: /);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('refuses network, MCP and Fynvra configuration tools', async () => {
    const env = setup('full');
    expect((await env.check('web_fetch', { url: 'https://example.com' }))?.reason).toContain(
      'restricted session: web_fetch is not allowed'
    );
    expect((await env.check('mcp__docs__search', { query: 'x' }))?.reason).toContain('not allowed');
    expect((await env.check('fynvra_config', { action: 'list' }))?.reason).toContain(
      'not available'
    );
    expect(env.request).not.toHaveBeenCalled();
  });

  it('ignores allowSession: a refused call stays refused', async () => {
    const request = vi.fn<ApprovalRequestFn>(async () => 'allowSession');
    const gate = createApprovalGate({
      mode: 'supervised',
      request,
      profile: () => 'restricted',
      cwd,
    });
    const call = { toolCallId: 'c', toolName: 'bash', input: { command: 'curl x' } };
    expect(await gate.check(call)).toMatchObject({ block: true });
    expect(await gate.check(call)).toMatchObject({ block: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed when the profile cannot be read', async () => {
    const gate = createApprovalGate({
      mode: 'full',
      request: async () => 'allow',
      profile: () => {
        throw new Error('gone');
      },
      cwd,
    });
    const result = await gate.check({
      toolCallId: 'c',
      toolName: 'bash',
      input: { command: 'curl x' },
    });
    expect(result?.reason).toMatch(/^restricted session: /);
  });
});

describe('approval gate: triage profile', () => {
  it('confines reads to the working directory and refuses sensitive files', async () => {
    const env = setup('full', 'triage');
    expect(await env.check(...read('src/a.ts'))).toBeUndefined();
    expect((await env.check(...read('../outside/secret.txt')))?.reason).toContain(
      'triage session: path outside the working directory is not allowed'
    );
    expect((await env.check(...read('.env.local')))?.reason).toContain('sensitive file');
  });
});

describe('approval gate: path forms and shell directories', () => {
  it('refuses short names, alternate data streams, dependency folders and malformed paths for writing', async () => {
    const env = setup();
    for (const target of [
      'PACKAG~1.JSO',
      'package.json::$DATA',
      'src/a.ts::$DATA',
      'node_modules/x.js',
      'src/a.ts.',
      'src/a.ts ',
      'src/*.ts',
    ]) {
      const result = await env.check(...write(target));
      expect(result?.reason, target).toMatch(/^restricted session: /);
    }
    expect((await env.check(...read('src/a?.ts')))?.reason).toMatch(/not allowed/);
    expect((await env.check(...read('~/x')))?.reason).toMatch(/not allowed/);
    expect(env.request).not.toHaveBeenCalled();
  });

  it('confines a working-directory argument of a shell tool', async () => {
    const env = setup();
    expect((await env.check('bash', { command: 'pnpm lint', cwd: outside }))?.reason).toContain(
      'path outside the working directory is not allowed'
    );
    expect(
      (await env.check('powershell', { command: 'pnpm lint', workdir: '..' }))?.reason
    ).toContain('outside');
    expect(await env.check('bash', { command: 'pnpm lint', cwd: 'src' })).toBeUndefined();
  });
});

describe('filterSensitiveResults', () => {
  const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: { x: 1 } });

  it('drops grep matches and context lines from sensitive files', () => {
    const result = filterSensitiveResults(
      'grep',
      text(
        [
          '.env:1: PASSWORD=hunter2',
          'config/.env.local-2- TOKEN=x',
          'keys/server.pem:3: -----BEGIN',
          'src/a.ts:4: const PASSWORD_FIELD = 1;',
          'docs/a-1- b.md:2: PASSWORD',
        ].join('\n')
      )
    );
    expect(result.content).toEqual([
      { type: 'text', text: 'src/a.ts:4: const PASSWORD_FIELD = 1;\ndocs/a-1- b.md:2: PASSWORD' },
    ]);
    expect(result.details).toBeUndefined();
  });

  it('drops sensitive entries from find and ls and keeps other tools as they are', () => {
    expect(filterSensitiveResults('find', text('src/a.ts\n.env\nid_rsa.pub')).content).toEqual([
      { type: 'text', text: 'src/a.ts' },
    ]);
    expect(filterSensitiveResults('ls', text('.env\n.npmrc')).content).toEqual([
      { type: 'text', text: 'No results (sensitive files are hidden)' },
    ]);
    const untouched = text('src/a.ts');
    expect(filterSensitiveResults('ls', untouched)).toBe(untouched);
    const read = text('.env:1: x');
    expect(filterSensitiveResults('read', read)).toBe(read);
  });
});
