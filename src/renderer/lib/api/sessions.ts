import { type FynvraSessionEvent, type FynvraSessionEventBody, getBuiltinRole } from '@fynvra/core';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  ChatToolCall,
  ModelProviderOption,
  SessionEventEnvelope,
  SessionModelRef,
  SessionStatus,
  SessionSummary,
} from '@shared/types/chat';
import type { SessionsApi } from '../../../preload/domains/sessions';
import type { FynvraApi } from '../../../preload/types';

// §9.3 的 SessionsApi 由 preload 定义；Renderer 统一从这里取
export type { SessionsApi };

/**
 * 会话 API：preload 注入的 `window.fynvra.sessions`。缺这个域（旧 preload、浏览器里预览）
 * 或 `mock: true` 时退回内存 mock。
 *
 * 只经 `globalThis` 读，不碰 DOM 类型：本模块会被 node 环境的测试 import。
 */
export function getSessionsApi(options: { mock?: boolean } = {}): SessionsApi {
  const bridge = (globalThis as { fynvra?: Partial<FynvraApi> }).fynvra;
  if (!options.mock && bridge?.sessions) return bridge.sessions;
  return createMockSessionsApi();
}

export interface MockSessionsOptions {
  /** 流式片段之间的间隔（ms） */
  stepMs?: number;
  now?: () => number;
}

interface MockSession {
  summary: SessionSummary;
  seq: number;
  /** 模拟 pi jsonl：消息在 message_end 时落盘，工具结果回填到发起它的消息上 */
  history: ChatMessage[];
  run: AbortController | null;
  approvals: Map<string, (decision: ApprovalDecision) => void>;
}

class Aborted extends Error {}

const STREAM_CHUNK = 4;
const MOCK_MODEL: SessionModelRef = {
  providerId: 'mock',
  modelId: 'mock-model',
  thinking: 'medium',
};
/** mock 的可选模型：档位集合各不相同，便于看选择器只渲染模型自己的档位 */
const MOCK_PROVIDERS: ModelProviderOption[] = [
  {
    providerId: 'mock',
    name: 'Mock',
    api: 'anthropic-messages',
    models: [
      {
        id: 'mock-model',
        name: 'Mock Model',
        thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultThinking: 'medium',
      },
      { id: 'mock-fast', name: 'Mock Fast（不推理）', thinkingLevels: [] },
    ],
  },
  {
    providerId: 'mock-openai',
    name: 'Mock OpenAI',
    api: 'openai-responses',
    models: [
      {
        id: 'mock-gpt',
        name: 'Mock GPT',
        thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
        defaultThinking: 'medium',
      },
    ],
  },
];

/**
 * 内存里的假会话后端：prompt 之后按脚本推送流式 `thinking_delta` / `text_delta`、工具调用、
 * 一次需要审批的 bash 调用、`usage` 与 `agent_settled`，便于不接 Main 时在 `pnpm dev` 里看效果。
 * orchestrator 会话演示 `dispatch_task` / `wait_for_workers`，其他角色演示 `report_done`。
 */
export function createMockSessionsApi(options: MockSessionsOptions = {}): SessionsApi {
  const stepMs = options.stepMs ?? 45;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, MockSession>();
  const eventListeners = new Set<(envelope: SessionEventEnvelope) => void>();
  const changedListeners = new Set<(workspaceId: string) => void>();
  const approvalListeners = new Set<(request: ApprovalRequest) => void>();
  const lastModels = new Map<string, SessionModelRef>();
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  const subscribe =
    <T>(listeners: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

  function changed(session: MockSession, status?: SessionStatus): void {
    if (status) session.summary = { ...session.summary, status };
    session.summary = { ...session.summary, updatedAt: now() };
    for (const listener of changedListeners) listener(session.summary.workspaceId);
  }

  function emit(session: MockSession, event: FynvraSessionEventBody): void {
    session.seq += 1;
    const envelope: SessionEventEnvelope = {
      sessionId: session.summary.id,
      event: { ...event, seq: session.seq } as FynvraSessionEvent,
    };
    for (const listener of eventListeners) listener(envelope);
  }

  function sleep(signal: AbortSignal, steps = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Aborted());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Aborted());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, stepMs * steps);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function waitForDecision(
    session: MockSession,
    requestId: string,
    signal: AbortSignal
  ): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        session.approvals.delete(requestId);
        reject(new Aborted());
      };
      session.approvals.set(requestId, (decision) => {
        signal.removeEventListener('abort', onAbort);
        session.approvals.delete(requestId);
        resolve(decision);
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 一轮对话的脚本；中止时由 prompt 统一收尾 */
  async function play(session: MockSession, text: string, signal: AbortSignal): Promise<void> {
    const sessionId = session.summary.id;
    const orchestrator = session.summary.roleId === 'orchestrator';
    // 中止时收尾要用：已流出但还没 message_end 的正文、正在执行的工具
    const progress: { streamed: string; tool: { id: string; name: string } | null } = {
      streamed: '',
      tool: null,
    };

    const stream = async (type: 'text_delta' | 'thinking_delta', content: string) => {
      const chars = Array.from(content);
      for (let index = 0; index < chars.length; index += STREAM_CHUNK) {
        await sleep(signal);
        const delta = chars.slice(index, index + STREAM_CHUNK).join('');
        if (type === 'text_delta') progress.streamed += delta;
        emit(session, { type, delta });
      }
    };

    const endAssistant = (reply: string, thinking: string | undefined, calls: ChatToolCall[]) => {
      emit(session, { type: 'message_end', role: 'assistant', text: reply, stopReason: 'stop' });
      progress.streamed = '';
      const usage = {
        inputTokens: 1_200 + text.length * 3,
        outputTokens: Math.ceil(reply.length / 2) + 40,
        costUsd: 0.0042,
      };
      session.history.push({
        id: nextId('entry'),
        sessionId,
        role: 'assistant',
        text: reply,
        ...(thinking ? { thinking } : {}),
        toolCalls: calls.map((call) => ({ ...call, status: 'running' })),
        createdAt: now(),
        streaming: false,
        usage,
      });
      emit(session, {
        type: 'usage',
        provider: MOCK_MODEL.providerId,
        model: MOCK_MODEL.modelId,
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usage.inputTokens + usage.outputTokens,
        cost: usage.costUsd,
      });
    };

    const tool = async (call: ChatToolCall, output: string, isError = false, steps = 6) => {
      progress.tool = { id: call.id, name: call.name };
      const startedAt = now();
      emit(session, {
        type: 'tool_start',
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
      });
      await sleep(signal, steps);
      const durationMs = Math.max(1, now() - startedAt);
      progress.tool = null;
      emit(session, {
        type: 'tool_end',
        toolCallId: call.id,
        toolName: call.name,
        isError,
        output,
        outputTruncated: false,
        durationMs,
      });
      const persisted = session.history
        .flatMap((message) => message.toolCalls)
        .find((candidate) => candidate.id === call.id);
      if (persisted) {
        Object.assign(persisted, { status: isError ? 'error' : 'done', output, durationMs });
      }
    };

    try {
      emit(session, { type: 'message_end', role: 'user', text });
      session.history.push({
        id: nextId('entry'),
        sessionId,
        role: 'user',
        text,
        toolCalls: [],
        createdAt: now(),
        streaming: false,
      });

      const thinking = `用户的请求是「${summarize(text)}」。先列目录、读 package.json，再申请运行测试。`;
      await stream('thinking_delta', thinking);
      const intro = [
        `收到，我来处理「${summarize(text)}」。`,
        '',
        '> 当前是 **mock 模式**：没有连接真实模型，下面的流式输出、工具调用和审批都是演示数据。',
        '',
        '先看一下仓库结构，再跑一遍测试。',
      ].join('\n');
      await stream('text_delta', intro);

      const ls: ChatToolCall = {
        id: nextId('call'),
        name: 'ls',
        args: { path: '.' },
        status: 'running',
      };
      const read: ChatToolCall = {
        id: nextId('call'),
        name: 'read',
        args: { path: 'package.json' },
        status: 'running',
      };
      const bash: ChatToolCall = {
        id: nextId('call'),
        name: 'bash',
        args: { command: 'pnpm test' },
        status: 'running',
      };
      endAssistant(intro, thinking, [ls, read, bash]);
      await tool(ls, 'README.md\ndocs/\npackage.json\npackages/\nsrc/');
      await tool(read, '{\n  "name": "fynvra",\n  "private": true,\n  "type": "module"\n}');

      // 与真实审批门一样看会话当前的档位：完全放行时命令不再询问
      let decision: ApprovalDecision = 'allow';
      if (session.summary.approvalMode !== 'full') {
        const requestId = nextId('approval');
        emit(session, {
          type: 'approval_request',
          requestId,
          toolCallId: bash.id,
          toolName: 'bash',
          args: bash.args,
        });
        const request: ApprovalRequest = {
          id: requestId,
          sessionId,
          kind: 'command',
          title: 'bash',
          detail: 'pnpm test',
          expiresAt: now() + 10 * 60_000,
        };
        for (const listener of approvalListeners) listener(request);
        changed(session, 'waiting-approval');
        decision = await waitForDecision(session, requestId, signal);
        changed(session, 'running');
      }
      const approved = decision !== 'deny';
      if (approved) {
        await tool(
          bash,
          ' RUN  v4.1.12\n\n Test Files  12 passed (12)\n      Tests  128 passed (128)\n   Duration  3.21s',
          false,
          14
        );
      } else {
        await tool(bash, '用户拒绝了这次调用', true, 1);
      }

      const extra: ChatToolCall[] = orchestrator
        ? [
            {
              id: nextId('call'),
              name: 'dispatch_task',
              args: {
                title: '为设置页补充单元测试',
                spec: '在 src/renderer/components/settings 下补 providerForm 的边界用例……',
                role: 'worker',
              },
              status: 'running',
            },
            {
              id: nextId('call'),
              name: 'wait_for_workers',
              args: { timeout_ms: 600_000, until: 'all' },
              status: 'running',
            },
          ]
        : [
            {
              id: nextId('call'),
              name: 'report_done',
              args: {
                outcome: approved ? 'succeeded' : 'failed',
                summary: approved
                  ? '读了仓库结构并跑通测试，128 个用例全部通过。'
                  : '测试命令的审批被拒绝，没能完成验证。',
                files_modified: ['src/renderer/App.tsx'],
              },
              status: 'running',
            },
          ];
      const handoff = orchestrator ? '接下来把任务派给 worker：' : '向主 agent 汇报结果：';
      await stream('text_delta', handoff);
      endAssistant(handoff, undefined, extra);
      for (const call of extra) {
        await tool(
          call,
          mockToolOutput(call.name),
          false,
          call.name === 'wait_for_workers' ? 20 : 6
        );
      }

      const summary = [
        '完成了，总结如下：',
        '',
        '| 步骤 | 结果 |',
        '| --- | --- |',
        '| 读取仓库结构 | ✅ |',
        `| 运行测试 | ${approved ? '✅ 128 个用例通过' : '⏭️ 已跳过（审批被拒绝）'} |`,
        '',
        '顺手给一段示例代码：',
        '',
        '```ts',
        'export function sum(values: number[]): number {',
        '  return values.reduce((total, value) => total + value, 0);',
        '}',
        '```',
        '',
        '- 支持 **GFM** 表格、列表与 `行内代码`',
        '- 代码块右上角可以复制',
      ].join('\n');
      await stream('text_delta', summary);
      endAssistant(summary, undefined, []);
      emit(session, { type: 'agent_settled', aborted: false });
      changed(session, 'idle');
    } catch (error) {
      if (!(error instanceof Aborted)) throw error;
      if (progress.tool) {
        const { id, name } = progress.tool;
        emit(session, {
          type: 'tool_end',
          toolCallId: id,
          toolName: name,
          isError: true,
          output: '已中止',
          outputTruncated: false,
        });
      }
      if (progress.streamed) {
        emit(session, {
          type: 'message_end',
          role: 'assistant',
          text: progress.streamed,
          stopReason: 'aborted',
        });
        session.history.push({
          id: nextId('entry'),
          sessionId,
          role: 'assistant',
          text: progress.streamed,
          toolCalls: [],
          createdAt: now(),
          streaming: false,
        });
      }
      for (const message of session.history) {
        for (const call of message.toolCalls) if (call.status === 'running') call.status = 'error';
      }
      emit(session, { type: 'agent_settled', aborted: true });
      changed(session, 'idle');
    }
  }

  const missing = () => ({ ok: false, error: '会话不存在' }) as const;

  return {
    async list(workspaceId) {
      const list = [...sessions.values()]
        .map((session) => session.summary)
        .filter((summary) => summary.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return { ok: true, sessions: list };
    },

    async create(input) {
      const time = now();
      const summary: SessionSummary = {
        id: nextId('mock-session'),
        workspaceId: input.workspaceId,
        roleId: input.roleId,
        title: '新会话',
        cwd: '(mock)',
        status: 'idle',
        createdAt: time,
        updatedAt: time,
        model: input.model ?? MOCK_MODEL,
        // 与 Main 相同：取角色的档位（mock 只认内置角色，其余按全程审批）
        approvalMode: getBuiltinRole(input.roleId)?.approvalMode ?? 'supervised',
        branch: 'main',
      };
      const session: MockSession = {
        summary,
        seq: 0,
        history: [],
        run: null,
        approvals: new Map(),
      };
      sessions.set(summary.id, session);
      lastModels.set(input.workspaceId, summary.model ?? MOCK_MODEL);
      changed(session);
      return { ok: true, session: summary };
    },

    async setModel({ sessionId, model }) {
      const session = sessions.get(sessionId);
      if (!session) return missing();
      if (session.run) return { ok: false, error: '会话正在运行，等本轮结束再切换模型' };
      session.summary = { ...session.summary, model };
      lastModels.set(session.summary.workspaceId, model);
      changed(session);
      return { ok: true, session: session.summary };
    },

    async setApprovalMode({ sessionId, mode }) {
      const session = sessions.get(sessionId);
      if (!session) return missing();
      // 与 Main 相同：运行中也可以切，下一次需要审批的调用起生效
      session.summary = { ...session.summary, approvalMode: mode };
      changed(session);
      return { ok: true, session: session.summary };
    },

    async modelOptions(input = {}) {
      const lastUsed = input.workspaceId ? lastModels.get(input.workspaceId) : undefined;
      return {
        ok: true,
        providers: structuredClone(MOCK_PROVIDERS),
        ...(lastUsed ? { lastUsed } : {}),
      };
    },

    async remove(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return missing();
      session.run?.abort();
      sessions.delete(sessionId);
      for (const listener of changedListeners) listener(session.summary.workspaceId);
      return { ok: true };
    },

    async prompt({ sessionId, text }) {
      const session = sessions.get(sessionId);
      if (!session) return missing();
      if (!text.trim()) return { ok: false, error: '消息不能为空' };
      if (session.run) return { ok: false, error: '会话正在运行' };
      const run = new AbortController();
      session.run = run;
      if (session.history.length === 0) {
        session.summary = { ...session.summary, title: summarize(text) };
      }
      changed(session, 'running');
      void play(session, text, run.signal).finally(() => {
        if (session.run === run) session.run = null;
      });
      return { ok: true };
    },

    async abort(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return missing();
      session.run?.abort();
      return { ok: true };
    },

    async history(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return missing();
      return { ok: true, messages: structuredClone(session.history) };
    },

    async respondApproval({ sessionId, requestId, decision }) {
      const resolve = sessions.get(sessionId)?.approvals.get(requestId);
      if (!resolve) return { ok: false, error: '审批请求不存在或已过期' };
      resolve(decision);
      return { ok: true };
    },

    onEvent: subscribe(eventListeners),
    onSessionsChanged: subscribe(changedListeners),
    onApprovalRequest: subscribe(approvalListeners),
  };
}

function summarize(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 24 ? `${line.slice(0, 23)}…` : line;
}

function mockToolOutput(name: string): string {
  switch (name) {
    case 'dispatch_task':
      return [
        '## Task dispatched',
        '- task_id: `task_1`',
        '- dispatch_id: `dispatch_1`',
        '- branch: `fynvra/settings-tests`',
      ].join('\n');
    case 'wait_for_workers':
      return '## Workers settled\n- `dispatch_1` · succeeded · 补了 6 个用例';
    case 'report_done':
      return '## Reported\nYour coordinator has been notified.';
    default:
      return 'ok';
  }
}
