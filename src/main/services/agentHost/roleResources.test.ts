import type { Role } from '@fynvra/core';
import type { SkillEntry } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import type { StoredMcpServer } from '../mcp/mcpRegistry';
import { createRoleResourceResolver } from './roleResources';

const skills: SkillEntry[] = [
  { id: 'pdf', name: 'pdf', path: '/skills/pdf', enabled: true },
  { id: 'docx', name: 'docx', path: '/skills/docx', enabled: false },
  { id: 'xlsx', name: 'xlsx', path: '/skills/xlsx', enabled: true },
];

const servers: StoredMcpServer[] = [
  {
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    enabled: true,
    env: { GITHUB_TOKEN: 'ghp_secret' },
  },
  {
    id: 'context7',
    name: 'Context7',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    enabled: true,
    headers: { Authorization: 'Bearer secret' },
  },
  {
    id: 'legacy',
    name: 'Legacy',
    transport: 'sse',
    url: 'https://legacy.example/sse',
    enabled: true,
  },
  { id: 'off', name: 'Off', transport: 'stdio', command: 'off-mcp', enabled: false },
];

function roleWith(patch: Pick<Role, 'skillIds' | 'mcpServerIds'>): Role {
  return { id: 'tester', name: 'Tester', tools: 'all', approvalMode: 'auto-edits', ...patch };
}

function setup() {
  const reads = { skills: 0, mcpServers: 0 };
  const resolve = createRoleResourceResolver({
    skills: {
      list: async () => {
        reads.skills += 1;
        return structuredClone(skills);
      },
    },
    mcpServers: {
      list: async () => {
        reads.mcpServers += 1;
        return structuredClone(servers);
      },
    },
  });
  return { resolve, reads };
}

describe('createRoleResourceResolver', () => {
  it('resolves each role instruction choice on every spawn without caching the text', async () => {
    const choices: (string | null | undefined)[] = [];
    let content = 'first';
    const resolve = createRoleResourceResolver({
      skills: { list: async () => [] },
      mcpServers: { list: async () => [] },
      instructions: {
        resolve: async (choice) => {
          choices.push(choice);
          return choice === null ? undefined : { name: choice ?? 'global', content };
        },
      },
    });
    const role = roleWith({ skillIds: [], mcpServerIds: [] });
    expect((await resolve(role)).instructionFile).toEqual({ name: 'global', content: 'first' });
    content = 'updated';
    expect((await resolve(role)).instructionFile).toEqual({ name: 'global', content: 'updated' });
    expect((await resolve({ ...role, instructionFileId: null })).instructionFile).toBeUndefined();
    expect((await resolve({ ...role, instructionFileId: 'specific' })).instructionFile).toEqual({
      name: 'specific',
      content: 'updated',
    });
    expect(choices).toEqual([undefined, undefined, null, 'specific']);
  });

  it('takes the paths of the enabled skills the role references, in role order', async () => {
    const { resolve } = setup();
    expect(
      await resolve(roleWith({ skillIds: ['xlsx', 'docx', 'pdf'], mcpServerIds: [] }))
    ).toEqual({ skills: ['/skills/xlsx', '/skills/pdf'], mcpServers: [], warnings: [] });
  });

  it('maps the enabled MCP servers: stdio keeps command / args / env, http and sse keep url / headers', async () => {
    const { resolve } = setup();
    const resources = await resolve(
      roleWith({ skillIds: [], mcpServerIds: ['github', 'context7', 'legacy', 'off'] })
    );
    expect(resources).toEqual({
      skills: [],
      mcpServers: [
        {
          name: 'github',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_secret' },
        },
        {
          name: 'context7',
          url: 'https://mcp.context7.com/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
        { name: 'legacy', url: 'https://legacy.example/sse' },
      ],
      warnings: [],
    });
  });

  it('skips ids that are no longer registered and reports each of them as a warning', async () => {
    const { resolve } = setup();
    const resources = await resolve(
      roleWith({ skillIds: ['pdf', 'gone-skill'], mcpServerIds: ['gone-mcp', 'github'] })
    );
    expect(resources.skills).toEqual(['/skills/pdf']);
    expect(resources.mcpServers.map((server) => server.name)).toEqual(['github']);
    expect(resources.warnings).toEqual([
      expect.stringContaining('gone-skill'),
      expect.stringContaining('gone-mcp'),
    ]);
    // 警告里不带 env / headers 的值
    expect(resources.warnings.join('\n')).not.toContain('secret');
  });

  it('lists each referenced id once', async () => {
    const { resolve } = setup();
    const resources = await resolve(
      roleWith({ skillIds: ['pdf', 'pdf'], mcpServerIds: ['github', 'github'] })
    );
    expect(resources.skills).toEqual(['/skills/pdf']);
    expect(resources.mcpServers).toHaveLength(1);
  });

  it('does not read the registries for a role without skills or MCP servers', async () => {
    const { resolve, reads } = setup();
    expect(await resolve(roleWith({ skillIds: [], mcpServerIds: [] }))).toEqual({
      skills: [],
      mcpServers: [],
      warnings: [],
    });
    expect(reads).toEqual({ skills: 0, mcpServers: 0 });
  });

  it('reads the registries on every call, so settings changes reach the next session', async () => {
    const { resolve, reads } = setup();
    const role = roleWith({ skillIds: ['pdf'], mcpServerIds: ['github'] });
    await resolve(role);
    await resolve(role);
    expect(reads).toEqual({ skills: 2, mcpServers: 2 });
  });
});
