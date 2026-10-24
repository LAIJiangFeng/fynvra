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
describe('createPiSessionFactory approval channel', () => {
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

  it('runs the role approval gate through the approval channel of the supervisor', async () => {
    const cwd = join(tmp, 'repo');
    const request = vi.fn<ApprovalRequestFn>(async () => 'deny');
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
      approval: { request },
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
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'write', kind: 'file-write', detail: 'gated.txt' }),
      expect.any(AbortSignal)
    );
    expect(existsSync(join(cwd, 'gated.txt'))).toBe(false);
  });

  it('switches the approval mode of the live session: full lets the write through', async () => {
    const cwd = join(tmp, 'repo');
    const request = vi.fn<ApprovalRequestFn>(async () => 'deny');
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
      approval: { request },
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
    expect(existsSync(join(cwd, 'allowed.txt'))).toBe(true);
  });
});
