import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryHost } from '../host';
import {
  createMemoryTools,
  MEMORY_FEEDBACK_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME,
  MEMORY_WRITE_TOOL_NAME,
} from './memoryTools';

function memoryHost(overrides: Partial<MemoryHost> = {}) {
  const ok = async () => ({ ok: true as const, result: { id: 7 } });
  return {
    write: vi.fn<MemoryHost['write']>(ok),
    search: vi.fn<MemoryHost['search']>(ok),
    feedback: vi.fn<MemoryHost['feedback']>(ok),
    ...overrides,
  };
}

function tool(host: MemoryHost, name: string): ToolDefinition {
  const found = createMemoryTools(host, { write: true }).find((item) => item.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

/** 走 prepareArguments 再 execute，和 pi 调用工具时一样 */
async function run(host: MemoryHost, name: string, raw: unknown) {
  const definition = tool(host, name);
  const params = definition.prepareArguments ? definition.prepareArguments(raw) : raw;
  const result = await definition.execute(
    'call',
    params as never,
    undefined,
    undefined,
    {} as never
  );
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  return { text, isError: (result as { isError?: boolean }).isError === true };
}

describe('createMemoryTools', () => {
  it('registers project_memory_write only when writable', () => {
    const host = memoryHost();
    expect(createMemoryTools(host, { write: false }).map((item) => item.name)).toEqual([
      MEMORY_SEARCH_TOOL_NAME,
      MEMORY_FEEDBACK_TOOL_NAME,
    ]);
    expect(createMemoryTools(host, { write: true }).map((item) => item.name)).toContain(
      MEMORY_WRITE_TOOL_NAME
    );
  });
});

describe('project_memory_search', () => {
  it('defaults limit to 10 and lists when neither query nor ids is given', async () => {
    const host = memoryHost();
    const result = await run(host, MEMORY_SEARCH_TOOL_NAME, { category: 'Pitfall', query: '  ' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"id": 7');
    expect(host.search).toHaveBeenCalledWith({ category: 'pitfall', limit: 10 }, undefined);
  });

  it('normalizes ids and passes query and limit', async () => {
    const host = memoryHost();
    await run(host, MEMORY_SEARCH_TOOL_NAME, { query: ' build ', ids: '3, 4,3', limit: '5' });
    expect(host.search).toHaveBeenCalledWith({ query: 'build', ids: [3, 4], limit: 5 }, undefined);
  });

  it.each([
    [{ ids: Array.from({ length: 21 }, (_, index) => index + 1) }, 'at most 20'],
    [{ ids: [0] }, 'positive integers'],
    [{ limit: 21 }, 'limit'],
    [{ limit: 0 }, 'limit'],
    [{ category: 'misc' }, 'category'],
  ])('rejects %j', async (args, message) => {
    const host = memoryHost();
    const result = await run(host, MEMORY_SEARCH_TOOL_NAME, args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(host.search).not.toHaveBeenCalled();
  });
});

describe('project_memory_feedback', () => {
  it('passes the normalized feedback', async () => {
    const host = memoryHost();
    await run(host, MEMORY_FEEDBACK_TOOL_NAME, { id: '2', verdict: 'Outdated', note: ' moved ' });
    expect(host.feedback).toHaveBeenCalledWith(
      { id: 2, verdict: 'outdated', note: 'moved' },
      undefined
    );
  });

  it.each([
    [{ verdict: 'useful' }, 'id'],
    [{ id: 1, verdict: 'wrong' }, 'verdict'],
    [{ id: 1, verdict: 'useful', note: 'x'.repeat(301) }, 'note'],
  ])('rejects %j', async (args, message) => {
    const host = memoryHost();
    const result = await run(host, MEMORY_FEEDBACK_TOOL_NAME, args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(host.feedback).not.toHaveBeenCalled();
  });
});

describe('project_memory_write', () => {
  it('passes a normalized add', async () => {
    const host = memoryHost();
    const result = await run(host, MEMORY_WRITE_TOOL_NAME, {
      action: 'ADD',
      category: 'workflow',
      content: ' Run pnpm install first. ',
      files: '.\\package.json, docs/a.md',
      quote: '记住这个',
      force: 'true',
    });
    expect(result.isError).toBe(false);
    expect(host.write).toHaveBeenCalledWith(
      {
        action: 'add',
        category: 'workflow',
        content: 'Run pnpm install first.',
        files: ['package.json', 'docs/a.md'],
        quote: '记住这个',
        force: true,
      },
      undefined
    );
  });

  it('passes update and delete', async () => {
    const host = memoryHost();
    await run(host, MEMORY_WRITE_TOOL_NAME, { action: 'update', id: 3, files: ['a.ts'] });
    await run(host, MEMORY_WRITE_TOOL_NAME, { action: 'delete', id: 3 });
    expect(host.write).toHaveBeenNthCalledWith(
      1,
      { action: 'update', id: 3, files: ['a.ts'] },
      undefined
    );
    expect(host.write).toHaveBeenNthCalledWith(2, { action: 'delete', id: 3 }, undefined);
  });

  it.each([
    [{ action: 'add', content: 'x' }, 'add needs category'],
    [{ action: 'add', category: 'rule' }, 'add needs content'],
    [{ action: 'add', category: 'rule', content: 'x'.repeat(501) }, 'content'],
    [{ action: 'add', category: 'rule', content: 'x', quote: 'q'.repeat(301) }, 'quote'],
    [
      {
        action: 'add',
        category: 'rule',
        content: 'x',
        files: Array.from({ length: 11 }, (_, index) => `f${index}.ts`),
      },
      'at most 10',
    ],
    [{ action: 'add', category: 'rule', content: 'x', files: ['../secret'] }, 'repo-relative'],
    [{ action: 'add', category: 'rule', content: 'x', files: ['C:/x'] }, 'repo-relative'],
    [{ action: 'update', content: 'x' }, 'update needs id'],
    [{ action: 'update', id: 1, quote: 'q' }, 'at least one of'],
    [{ action: 'delete' }, 'delete needs id'],
    [{ action: 'move', id: 1 }, 'action must be'],
  ])('rejects %j', async (args, message) => {
    const host = memoryHost();
    const result = await run(host, MEMORY_WRITE_TOOL_NAME, args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(host.write).not.toHaveBeenCalled();
  });

  it('turns host errors and host exceptions into error text', async () => {
    const failing = memoryHost({ write: async () => ({ ok: false, error: 'similar entries' }) });
    const failed = await run(failing, MEMORY_WRITE_TOOL_NAME, { action: 'delete', id: 1 });
    expect(failed).toEqual({ isError: true, text: expect.stringContaining('similar entries') });

    const throwing = memoryHost({
      search: async () => {
        throw new Error('host crashed');
      },
    });
    const thrown = await run(throwing, MEMORY_SEARCH_TOOL_NAME, {});
    expect(thrown).toEqual({ isError: true, text: expect.stringContaining('host crashed') });
  });
});
