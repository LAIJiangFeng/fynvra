import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPiSessionFactory } from './piSession';

// 真实的 pi 会话（faux 模型）：单独成文件，不受其他用例对 createRoleSession 的 mock 影响。
describe('createPiSessionFactory switching the model of a live pi session', () => {
  let tmp = '';
  let faux: FauxProviderHandle;
  let runtime: ModelRuntime;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fynvra-pi-session-model-'));
    await mkdir(join(tmp, 'repo'), { recursive: true });
    faux = fauxProvider({
      provider: 'fynvra-faux',
      models: [
        { id: 'faux-a' },
        { id: 'faux-b', reasoning: true },
        { id: 'faux-max', reasoning: true },
      ],
    });
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

  it('sends the next prompt to the new model with the new thinking level and keeps the history', async () => {
    const sessionFile = join(tmp, 'agent', 'sessions', 's1.jsonl');
    const open = createPiSessionFactory({
      agentDir: join(tmp, 'agent'),
      resolveModel: async (spec) => ({
        runtime,
        model: faux.getModel(spec.modelId) as Model<string>,
        ...(spec.thinking ? { thinking: spec.thinking } : {}),
      }),
    });
    const session = await open({
      identity: { sessionId: 's1', generation: 1 },
      spec: {
        role: {
          id: 'worker',
          name: 'Worker',
          skillIds: [],
          mcpServerIds: [],
          tools: 'readonly',
          approvalMode: 'full',
        },
        cwd: join(tmp, 'repo'),
        sessionFile,
        model: { providerId: 'fynvra-faux', api: faux.api, modelId: 'faux-a' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
    });
    const requests: { model: string; reasoning?: string; messages: number }[] = [];
    const answer =
      (text: string) =>
      (
        context: { messages: unknown[] },
        options: SimpleStreamOptions | undefined,
        _state: unknown,
        model: Model<string>
      ) => {
        requests.push({
          model: model.id,
          ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
          messages: context.messages.length,
        });
        return fauxAssistantMessage(text);
      };
    faux.setResponses([answer('from A'), answer('from B')]);
    try {
      await session.prompt('first question');
      await session.setModel({
        providerId: 'fynvra-faux',
        api: faux.api,
        modelId: 'faux-b',
        thinking: 'high',
      });
      await session.prompt('second question');
    } finally {
      await session.dispose();
    }

    expect(requests.map(({ messages: _messages, ...request }) => request)).toEqual([
      { model: 'faux-a' },
      { model: 'faux-b', reasoning: 'high' },
    ]);
    // 第二轮比第一轮多出第一轮的回答与新问题：历史保留（第一轮的计数含 pi 自己的消息）
    expect((requests[1]?.messages ?? 0) - (requests[0]?.messages ?? 0)).toBe(2);
    // pi 在 jsonl 里记下切换：重启后续写时 pi 也能读到
    const entries = (await readFile(sessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { type: string; modelId?: string; thinkingLevel?: string }
      );
    expect(
      entries.filter((entry) => entry.type === 'model_change').map((entry) => entry.modelId)
    ).toEqual(['faux-a', 'faux-b']);
    expect(
      entries.filter((entry) => entry.type === 'thinking_level_change').at(-1)?.thinkingLevel
    ).toBe('high');
  });

  it("switches to pi's max level and pi sends and records max", async () => {
    const sessionFile = join(tmp, 'agent', 'sessions', 's2.jsonl');
    // 像 claude-fable-5-1 / gpt-6-sol 那样显式映射了 max 的推理模型（models.ts 照搬目录里的映射）
    const modelOf = (modelId: string) => {
      const model = faux.getModel(modelId) as Model<string>;
      return modelId === 'faux-max' ? { ...model, thinkingLevelMap: { max: 'max' } } : model;
    };
    const open = createPiSessionFactory({
      agentDir: join(tmp, 'agent'),
      resolveModel: async (spec) => ({
        runtime,
        model: modelOf(spec.modelId),
        ...(spec.thinking ? { thinking: spec.thinking } : {}),
      }),
    });
    const session = await open({
      identity: { sessionId: 's2', generation: 1 },
      spec: {
        role: {
          id: 'worker',
          name: 'Worker',
          skillIds: [],
          mcpServerIds: [],
          tools: 'readonly',
          approvalMode: 'full',
        },
        cwd: join(tmp, 'repo'),
        sessionFile,
        model: { providerId: 'fynvra-faux', api: faux.api, modelId: 'faux-b', thinking: 'high' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
    });
    const reasoning: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        reasoning.push(options?.reasoning);
        return fauxAssistantMessage('at max');
      },
    ]);
    try {
      await session.setModel({
        providerId: 'fynvra-faux',
        api: faux.api,
        modelId: 'faux-max',
        thinking: 'max',
      });
      await session.prompt('think hard');
    } finally {
      await session.dispose();
    }

    expect(reasoning).toEqual(['max']);
    const levels = (await readFile(sessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; thinkingLevel?: string })
      .filter((entry) => entry.type === 'thinking_level_change')
      .map((entry) => entry.thinkingLevel);
    expect(levels.at(-1)).toBe('max');
  });
});
