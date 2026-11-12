import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@fynvra/core';
import type { SkillEntry } from '@shared/types/llm';
import { describe, expect, it, vi } from 'vitest';
import type { StoredMcpServer } from '../mcp/mcpRegistry';
import {
  type ConfigHostDeps,
  createConfigHost,
  type GitCloner,
  parseGitSource,
} from './configHost';

const worker: Role = {
  id: 'worker',
  name: 'Worker',
  skillIds: ['old'],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'supervised',
};

function setup(overrides: Partial<ConfigHostDeps> = {}) {
  const skills: SkillEntry[] = [
    { id: 'old', name: 'Old', path: '/x', enabled: true },
    { id: 'pdf', name: 'Pdf', path: '/y', enabled: true },
  ];
  const roles = new Map<string, Role>([['worker', { ...worker }]]);
  const servers: StoredMcpServer[] = [
    {
      id: 'gh',
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      enabled: false,
      env: { GITHUB_TOKEN: 'sekret-token' },
    } as StoredMcpServer,
  ];
  const deps = {
    skills: {
      list: vi.fn(async () => skills),
      add: vi.fn(async (items: { name: string; path: string }[]) => {
        const added = items.map((item) => ({ id: item.name, ...item, enabled: true }));
        skills.push(...added);
        return { added, skipped: [] };
      }),
    },
    roles: {
      list: vi.fn(async () => [...roles.values()]),
      get: vi.fn(async (id: string) => roles.get(id)),
      save: vi.fn(async (role: Role) => {
        roles.set(role.id, role);
        return { ok: true as const, role };
      }),
    },
    mcp: {
      list: vi.fn(async () => servers),
      get: vi.fn(async (id: string) => servers.find((server) => server.id === id)),
      upsert: vi.fn(async (input: { name: string; transport: 'stdio' }) => ({
        ok: true as const,
        server: { id: 'new', enabled: true, ...input, env: { K: 'v' } } as StoredMcpServer,
      })),
      remove: vi.fn(async (id: string) => id === 'gh'),
    },
    workflows: {
      list: vi.fn(async () => []),
      save: vi.fn(async (workflow) => ({ ok: true as const, workflow })),
      remove: vi.fn(async (id: string) => id === 'flow'),
    },
    plugins: {
      list: vi.fn(async () => []),
      install: vi.fn(async () => ({
        ok: true as const,
        plugin: {
          id: 'p',
          name: 'P',
          kind: 'npm',
          source: 'npm:p',
          path: '/p',
          enabled: true,
          installedAt: 1,
        },
      })),
      setEnabled: vi.fn(async (id: string, enabled: boolean) => ({
        ok: true as const,
        plugin: {
          id,
          name: 'P',
          kind: 'npm',
          source: 'npm:p',
          path: '/p',
          enabled,
          installedAt: 1,
        },
      })),
    },
    broadcast: vi.fn(),
    skillsDir: mkdtempSync(join(tmpdir(), 'fynvra-skills-')),
    ...overrides,
  } as unknown as ConfigHostDeps & {
    broadcast: ReturnType<typeof vi.fn>;
  };
  const host = createConfigHost(deps);
  const call = (input: unknown) => host.invoke('configure', input, new AbortController().signal);
  return { deps, host, call, roles };
}

function skillSource(): string {
  const root = mkdtempSync(join(tmpdir(), 'fynvra-src-'));
  mkdirSync(join(root, 'good'));
  writeFileSync(
    join(root, 'good', 'SKILL.md'),
    '---\nname: good-skill\ndescription: Does things\n---\n'
  );
  mkdirSync(join(root, 'empty'));
  return root;
}

describe('createConfigHost', () => {
  it('rejects unknown methods and non-object input', async () => {
    const { host, call } = setup();
    await expect(host.invoke('other', {}, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
    });
    await expect(call('list')).resolves.toMatchObject({ ok: false });
    await expect(call({ action: 'nope' })).resolves.toMatchObject({ ok: false });
  });

  it('list summarizes everything and never returns MCP env values', async () => {
    const { call } = setup();
    const result = await call({ action: 'list' });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sekret-token');
    expect(result).toMatchObject({
      result: {
        skills: [{ id: 'old' }, { id: 'pdf' }],
        mcpServers: [{ id: 'gh', envKeys: ['GITHUB_TOKEN'] }],
        roles: [{ id: 'worker', skillIds: ['old'] }],
      },
    });
  });

  it('skill_install registers a local skill and adds it to roles', async () => {
    const { call, deps, roles } = setup();
    const root = skillSource();
    const result = await call({
      action: 'skill_install',
      source: root,
      path: 'good',
      roles: ['worker'],
    });
    expect(result).toMatchObject({
      ok: true,
      result: { skill: { id: 'good-skill' }, roles: ['worker'] },
    });
    expect(deps.skills.add).toHaveBeenCalledWith([
      { name: 'good-skill', description: 'Does things', path: realpathSync(join(root, 'good')) },
    ]);
    expect(roles.get('worker')?.skillIds).toEqual(['old', 'good-skill']);
    expect(deps.broadcast).toHaveBeenCalledWith('skills:changed');
    expect(deps.broadcast).toHaveBeenCalledWith('roles:changed');
  });

  it('skill_install rejects a missing manifest, escaping paths, relative sources and unknown roles', async () => {
    const { call, deps } = setup();
    const root = skillSource();
    await expect(
      call({ action: 'skill_install', source: root, path: 'empty' })
    ).resolves.toMatchObject({ ok: false });
    const escaped = await call({
      action: 'skill_install',
      source: join(root, 'empty'),
      path: '../good',
    });
    expect(escaped).toMatchObject({ ok: false, error: expect.stringContaining('outside') });
    await expect(call({ action: 'skill_install', source: 'rel/dir' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      call({ action: 'skill_install', source: root, path: 'good', roles: ['ghost'] })
    ).resolves.toMatchObject({ ok: false });
    expect(deps.skills.add).not.toHaveBeenCalled();
  });

  it('skill_install clones git sources into the skills dir and removes failed clones', async () => {
    const clones: string[] = [];
    const cloneGit = vi.fn<GitCloner>(async (_url, _ref, dest) => {
      clones.push(dest);
      mkdirSync(join(dest, 'skills', 'foo'), { recursive: true });
      return { ok: true };
    });
    const { call } = setup({ cloneGit });
    const failed = await call({
      action: 'skill_install',
      source: 'https://github.com/o/repo/tree/main/skills/foo',
    });
    expect(failed).toMatchObject({ ok: false });
    expect(cloneGit).toHaveBeenCalledWith(
      'https://github.com/o/repo.git',
      'main',
      clones[0],
      expect.anything()
    );
    expect(existsSync(clones[0] as string)).toBe(false);
  });

  it('role_set_skills adds and removes skill ids, rejecting unknown ones', async () => {
    const { call, roles } = setup();
    await expect(
      call({ action: 'role_set_skills', role: 'worker', add: ['pdf'], remove: ['old'] })
    ).resolves.toMatchObject({
      ok: true,
      result: { role: 'worker', skillIds: ['pdf'] },
    });
    expect(roles.get('worker')?.skillIds).toEqual(['pdf']);
    await expect(
      call({ action: 'role_set_skills', role: 'worker', add: ['ghost'] })
    ).resolves.toMatchObject({ ok: false });
    await expect(
      call({ action: 'role_set_skills', role: 'nobody', add: ['pdf'] })
    ).resolves.toMatchObject({ ok: false });
  });

  it('mcp_upsert converts env maps, keeps enabled on update and returns keys only', async () => {
    const { call, deps } = setup();
    const result = await call({
      action: 'mcp_upsert',
      server: {
        id: 'gh',
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        env: { GITHUB_TOKEN: 'new-secret', KEEP: null },
      },
    });
    expect(deps.mcp.upsert).toHaveBeenCalledWith({
      id: 'gh',
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      enabled: false,
      env: [{ key: 'GITHUB_TOKEN', value: 'new-secret' }, { key: 'KEEP' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/new-secret|"v"/);
    expect(result).toMatchObject({ ok: true, result: { server: { envKeys: ['K'] } } });
    expect(deps.broadcast).toHaveBeenCalledWith('mcp:changed');
    await expect(
      call({ action: 'mcp_upsert', server: { name: 'x', transport: 'ftp' } })
    ).resolves.toMatchObject({ ok: false });
  });

  it('mcp_remove / workflow_upsert / workflow_remove', async () => {
    const { call, deps } = setup();
    await expect(call({ action: 'mcp_remove', id: 'gh' })).resolves.toMatchObject({ ok: true });
    await expect(call({ action: 'mcp_remove', id: 'none' })).resolves.toMatchObject({ ok: false });
    const workflow = {
      id: 'flow',
      name: 'Flow',
      steps: [{ id: 'dev', name: 'Dev', roleId: 'worker', instructions: 'Build it', needs: [] }],
    };
    await expect(call({ action: 'workflow_upsert', workflow })).resolves.toMatchObject({
      ok: true,
      result: { workflow: { id: 'flow' } },
    });
    await expect(
      call({ action: 'workflow_upsert', workflow: { id: 'bad' } })
    ).resolves.toMatchObject({ ok: false });
    expect(deps.workflows.save).toHaveBeenCalledTimes(1);
    await expect(call({ action: 'workflow_remove', id: 'flow' })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('plugin_install / plugin_enable / plugin_disable go through the plugin service', async () => {
    const { call, deps } = setup();
    await expect(call({ action: 'plugin_install', source: 'npm:p' })).resolves.toMatchObject({
      ok: true,
      result: { plugin: { id: 'p' } },
    });
    expect(deps.plugins.install).toHaveBeenCalledWith('npm:p');
    await call({ action: 'plugin_disable', id: 'p' });
    expect(deps.plugins.setEnabled).toHaveBeenCalledWith('p', false);
    await call({ action: 'plugin_enable', id: 'p' });
    expect(deps.plugins.setEnabled).toHaveBeenCalledWith('p', true);
  });
});

describe('parseGitSource', () => {
  it('splits GitHub tree URLs and refuses non-git strings', () => {
    expect(parseGitSource('https://github.com/a/b/tree/v1/x/y')).toEqual({
      url: 'https://github.com/a/b.git',
      ref: 'v1',
      subdir: 'x/y',
      name: 'b',
    });
    expect(parseGitSource('git@github.com:a/my-skill.git')).toMatchObject({ name: 'my-skill' });
    expect(parseGitSource('https://github.com/a/b/tree/-x/y')).toBeNull();
    expect(parseGitSource('D:\\skills\\foo')).toBeNull();
  });
});
