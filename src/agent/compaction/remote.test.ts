import type { ResolvedModel } from '@fynvra/agent-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remote, supportsAnthropicServerCompaction } from './remote';
import type { CompactionContext } from './types';

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claude-opus-4-6',
    provider: 'fynvra-abc',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}): CompactionContext {
  const resolved = {
    runtime: { getAuth: vi.fn(async () => ({ auth: { apiKey: 'sk-ant-api-secret' } })) },
    model: model(overrides),
  } as unknown as ResolvedModel;
  return {
    preparation: {
      firstKeptEntryId: 'kept-1',
      messagesToSummarize: [{ role: 'user', content: 'please fix the bug', timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 50_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 2_000 },
    } as never,
    model: resolved,
    sessionManager: undefined as never,
    signal: new AbortController().signal,
    aggressive: false,
  };
}

function fakeFetch(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('remote compaction', () => {
  it('detects official Anthropic compaction models, not relays or other APIs', () => {
    expect(supportsAnthropicServerCompaction(model() as never)).toBe(true);
    expect(
      supportsAnthropicServerCompaction(model({ id: 'claude-sonnet-4-20250514' }) as never)
    ).toBe(false);
    expect(supportsAnthropicServerCompaction(model({ id: 'claude-fable-5' }) as never)).toBe(true);
    expect(
      supportsAnthropicServerCompaction(model({ baseUrl: 'https://relay.example.com' }) as never)
    ).toBe(false);
    expect(
      supportsAnthropicServerCompaction(
        model({ api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }) as never
      )
    ).toBe(false);
  });

  it('skips a relay baseUrl without any request', async () => {
    const fetch = fakeFetch({});
    expect(await remote(context({ baseUrl: 'https://relay.example.com/anthropic' }))).toBe('skip');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the server compaction summary for an official Anthropic model', async () => {
    const fetch = fakeFetch({
      content: [{ type: 'compaction', content: 'server summary', signature: 'sig' }],
      stop_reason: 'compaction',
    });
    const result = await remote(context());
    expect(result).toMatchObject({
      summary: 'server summary',
      firstKeptEntryId: 'kept-1',
      tokensBefore: 50_000,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBe('compact-2026-09-04');
    expect(headers['x-api-key']).toBe('sk-ant-api-secret');
    const body = JSON.parse(String(init.body));
    expect(body.compaction.type).toBe('summarize');
    expect(body.messages[0].content).toContain('please fix the bug');
  });

  it('fails without leaking the provider body', async () => {
    fakeFetch({ error: { message: 'echo: please fix the bug' } }, 400);
    await expect(remote(context())).rejects.toThrow('remote compaction failed (HTTP 400)');
    fakeFetch({ content: [{ type: 'text', text: 'hi' }] });
    await expect(remote(context())).rejects.toThrow('no summary');
  });
});
