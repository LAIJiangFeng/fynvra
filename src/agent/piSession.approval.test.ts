import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ApprovalRequestFn } from '@fynvra/agent-runtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPiSessionFactory } from './piSession';

// 真实的 pi 会话（faux 模型）：单独成文件，不受其他用例对 createRoleSession 的 mock 影响。
describe('createPiSessionFactory operation notifications', () => {
  let tmp = '';
  let faux: FauxProviderHandle;
  let runtime: ModelRuntime;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fynvra-pi-session-approval-'));
    await mkdir(join(tmp, 'repo'), { recursive: true });
    faux = fauxProvider({ provider: 'fynvra-faux', models: [{ id: 'faux-model' }] });
    runtime = await ModelRuntime.create({
      authPath: join(tmp, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('notifies through the supervisor channel and writes without invoking legacy approval', async () => {
    const cwd = join(tmp, 'repo');
    const request = vi.fn<ApprovalRequestFn>(async () => 'deny');
    const notify = vi.fn();
    const open = createPiSessionFactory({
      agentDir: join(tmp, 'agent'),
      resolveModel: async () => ({ runtime, model: faux.getModel() }),
    });
    const session = await open({
      identity: { sessionId: 's1', generation: 1 },
      spec: {
        role: {
          id: 'careful',
          name: 'Careful',
          skillIds: [],
          mcpServerIds: [],
          tools: 'all',
          approvalMode: 'supervised',
        },
        cwd,
        sessionFile: join(tmp, 'agent', 'sessions', 's1.jsonl'),
        model: { providerId: 'fynvra-faux', api: faux.api, modelId: 'faux-model' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
      approval: { request, notify },
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'gated.txt', content: 'x' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('ok'),
    ]);
    try {
      await session.prompt('Write the file.');
    } finally {
      await session.dispose();
    }
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      toolCallId: expect.any(String),
      toolName: 'write',
      kind: 'file-write',
    });
    expect(request).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, 'gated.txt'))).toBe(true);
  });

  it('switches the live notification scope: full omits file notices without changing execution', async () => {
    const cwd = join(tmp, 'repo');
    const request = vi.fn<ApprovalRequestFn>(async () => 'deny');
    const notify = vi.fn();
    const open = createPiSessionFactory({
      agentDir: join(tmp, 'agent'),
      resolveModel: async () => ({ runtime, model: faux.getModel() }),
    });
    const session = await open({
      identity: { sessionId: 's2', generation: 1 },
      spec: {
        role: {
          id: 'careful',
          name: 'Careful',
          skillIds: [],
          mcpServerIds: [],
          tools: 'all',
          approvalMode: 'supervised',
        },
        cwd,
        sessionFile: join(tmp, 'agent', 'sessions', 's2.jsonl'),
        model: { providerId: 'fynvra-faux', api: faux.api, modelId: 'faux-model' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
      approval: { request, notify },
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'allowed.txt', content: 'x' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('ok'),
    ]);
    try {
      session.setApprovalMode('full');
      await session.prompt('Write the file.');
    } finally {
      await session.dispose();
    }
    expect(request).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, 'allowed.txt'))).toBe(true);
  });
});
