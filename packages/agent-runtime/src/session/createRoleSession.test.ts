import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type ToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getBuiltinRole, ORCHESTRATOR_ROLE_ID, type Role } from '@fynvra/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateRequest, ApprovalRequestFn } from '../approval/gate';
import type { ApprovalDecision } from '../approval/policy';
import { type FynvraSessionEvent, subscribeNormalized } from '../events/normalize';
import { ORCHESTRATION_TOOL_METHODS, type OrchestrationHost, type WorkerHost } from '../host';
import {
  IN_PLACE_ORCHESTRATOR_PROMPT,
  IN_PLACE_WORKER_CONTRACT_PROMPT,
  ORCHESTRATOR_PROMPT,
  WORKER_CONTRACT_PROMPT,
} from '../prompts/orchestratorPrompt';
import { profileLanguagePrompt } from '../prompts/profileLanguagePrompt';
import { RESTRICTED_COORDINATOR_PROMPT } from '../prompts/restrictedPrompt';
import {
  type CreateRoleSessionOptions,
  createRoleSession,
  type RoleSession,
} from './createRoleSession';

const READONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'git_readonly'];
const ORCHESTRATION_TOOLS = Object.keys(ORCHESTRATION_TOOL_METHODS);

function role(overrides: Partial<Role>): Role {
  return {
    id: 'worker',
    name: 'Worker',
    skillIds: [],
    mcpServerIds: [],
    tools: 'all',
    approvalMode: 'auto-edits',
    ...overrides,
  };
}

function orchestrationHost(): OrchestrationHost {
  const unused = async () => ({ ok: false as const, error: 'not used in this test' });
  return {
    dispatchTask: unused,
    listWorkers: unused,
    waitForWorkers: unused,
    readWorkerOutput: unused,
    sendToWorker: unused,
    reviewDiff: unused,
    runChecks: unused,
    mergeWorktree: unused,
    openPullRequest: unused,
    rejectWork: unused,
    cleanupWorktree: unused,
  };
}

function workerHost() {
  return {
    askCoordinator: vi.fn<WorkerHost['askCoordinator']>(async () => ({ ok: true, answer: 'yes' })),
    reportDone: vi.fn<WorkerHost['reportDone']>(async () => ({ ok: true })),
  } satisfies WorkerHost;
}

/** 模型实际收到的完整系统提示词（首条 system 消息加之后的更新） */
function systemText(context: TranscriptContext): string {
  return context.messages
    .filter((message) => message.role === 'system')
    .map((message) => getSystemMessageText(message))
    .join('\n');
}

/** pi 结构化系统提示词里的一段（`<name>…</name>`），如 Fynvra 追加的 `addendum` */
function section(prompt: string, name: string): string {
  return new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt)?.[1] ?? '';
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function builtinRole(id: string): Role {
  const found = getBuiltinRole(id);
  if (!found) throw new Error(`the builtin role "${id}" is missing`);
  return found;
}

let tmp = '';
let workdir = '';
let agentDir = '';
let runtime: ModelRuntime;
let faux: FauxProviderHandle;
const opened: RoleSession[] = [];

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'fynvra-role-session-'));
  workdir = path.join(tmp, 'repo');
  agentDir = path.join(tmp, 'agent');
  await mkdir(workdir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  faux = fauxProvider({
    provider: 'fynvra-faux',
    models: [{ id: 'faux-reasoner', reasoning: true }],
  });
  runtime = await ModelRuntime.create({
    authPath: path.join(tmp, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((created) => created.dispose()));
  faux.setResponses([]);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function open(overrides: Partial<CreateRoleSessionOptions> & { role: Role }) {
  const created = await createRoleSession({
    cwd: workdir,
    agentDir,
    model: { runtime, model: faux.getModel() },
    sessionManager: SessionManager.inMemory(workdir),
    host: null,
    resourcePaths: { skills: [], mcpServers: [] },
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    ...overrides,
  });
  opened.push(created);
  return created;
}

describe('createRoleSession tool policies', () => {
  it('gives the orchestrator only read-only and orchestration tools plus write_plan and write_doc', async () => {
    const { session } = await open({
      role: role({ id: 'orchestrator', tools: 'orchestrator', approvalMode: 'full' }),
      host: orchestrationHost(),
    });
    expect(session.getActiveToolNames().sort()).toEqual(
      [...READONLY_TOOLS, ...ORCHESTRATION_TOOLS, 'write_plan', 'write_doc', 'web_fetch'].sort()
    );
  });

  it('refuses to create an orchestrator without a host', async () => {
    await expect(
      open({ role: role({ id: 'orchestrator', tools: 'orchestrator' }), host: null })
    ).rejects.toThrow('needs an OrchestrationHost');
  });

  it('gives a read-only worker the read-only tools plus the worker tools', async () => {
    const { session } = await open({
      role: role({ id: 'reviewer', tools: 'readonly' }),
      workerHost: workerHost(),
    });
    expect(session.getActiveToolNames().sort()).toEqual(
      [...READONLY_TOOLS, 'web_fetch', 'ask_coordinator', 'report_done'].sort()
    );
  });

  it('gives an all-tools worker the pi default tools plus the worker tools', async () => {
    const { session } = await open({ role: role({ tools: 'all' }), workerHost: workerHost() });
    const active = session.getActiveToolNames();
    expect(active).toEqual(
      expect.arrayContaining(['read', 'edit', 'write', 'web_fetch', 'report_done'])
    );
    expect(active).toContain('ask_coordinator');
    expect(active).not.toContain('git_readonly');
    expect(active).not.toContain('dispatch_task');
  });

  it('applies the thinking level from the role', async () => {
    const { session } = await open({
      role: role({
        model: { providerId: 'fynvra-faux', modelId: 'faux-reasoner', thinking: 'high' },
      }),
    });
    expect(session.thinkingLevel).toBe('high');
  });

  describe("pi's max level", () => {
    // 像 claude-fable-5-1 / gpt-6-sol 那样显式映射了 xhigh 与 max 的推理模型
    const withMax = () => ({
      ...faux.getModel(),
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    });

    it('passes max through to pi when the model offers it', async () => {
      const { session } = await open({
        role: role({}),
        model: { runtime, model: withMax(), thinking: 'max' },
      });
      expect(session.thinkingLevel).toBe('max');
      expect(session.getAvailableThinkingLevels()).toContain('max');
    });

    it("passes the role's max through when the session has no level of its own", async () => {
      const { session } = await open({
        role: role({
          model: { providerId: 'fynvra-faux', modelId: 'faux-reasoner', thinking: 'max' },
        }),
        model: { runtime, model: withMax() },
      });
      expect(session.thinkingLevel).toBe('max');
    });

    it('does not filter levels itself: pi clamps max on a model without it', async () => {
      // 落定档位是 worker（models.ts 的 pickThinkingLevel）的事；这里原样交给 pi，pi 就近取到 high
      const { session } = await open({
        role: role({}),
        model: { runtime, model: faux.getModel(), thinking: 'max' },
      });
      expect(session.thinkingLevel).toBe('high');
    });
  });
});

describe('createRoleSession end to end with a scripted model', () => {
  it('runs report_done through the worker host and stops after it', async () => {
    const host = workerHost();
    const { session } = await open({
      role: role({ systemPrompt: 'You are the test engineer. FYNVRA_ROLE_MARKER' }),
      workerHost: host,
    });
    const contexts: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall('report_done', {
            outcome: 'success',
            summary: 'Added tests; pnpm test passes.',
            files_modified: ['src/a.test.ts'],
          }),
          { stopReason: 'toolUse' }
        );
      },
      fauxAssistantMessage('should not be requested'),
    ]);
    const events: FynvraSessionEvent[] = [];
    const subscription = subscribeNormalized(session, (event) => events.push(event));

    await session.prompt('Write the tests.');
    subscription.unsubscribe();

    expect(host.reportDone).toHaveBeenCalledWith('succeeded', 'Added tests; pnpm test passes.', [
      'src/a.test.ts',
    ]);
    // report_done 设置 terminate：同一批工具调用后不再请求模型
    expect(faux.getPendingResponseCount()).toBe(1);

    const prompt = systemText(contexts[0] as TranscriptContext);
    expect(prompt).toContain('FYNVRA_ROLE_MARKER');
    expect(prompt).toContain(WORKER_CONTRACT_PROMPT);
    expect(prompt).not.toContain(ORCHESTRATOR_PROMPT);

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['message_end', 'tool_start', 'tool_end', 'agent_settled'])
    );
    expect(events.find((event) => event.type === 'tool_end')).toMatchObject({
      toolName: 'report_done',
      isError: false,
    });
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('gives the builtin orchestrator its persona and the tool guide once, however many runs follow', async () => {
    const { session } = await open({
      role: builtinRole(ORCHESTRATOR_ROLE_ID),
      host: orchestrationHost(),
    });
    const contexts: TranscriptContext[] = [];
    const reply = (text: string) => (context: TranscriptContext) => {
      contexts.push(context);
      return fauxAssistantMessage(text);
    };
    faux.setResponses([reply('first'), reply('second')]);
    await session.prompt('Plan the work.');
    await session.prompt('Continue.');

    expect(contexts).toHaveLength(2);
    const prompt = systemText(contexts[1] as TranscriptContext);
    expect(count(prompt, 'You never implement anything yourself')).toBe(1);
    expect(count(prompt, 'Work loop')).toBe(1);
    expect(count(prompt, ORCHESTRATOR_PROMPT)).toBe(1);
    expect(prompt).not.toContain(WORKER_CONTRACT_PROMPT);
    // pi 自带的工具列表之外，追加段（角色提示词 + 工具说明）自己也点名每个编排工具
    const appended = section(prompt, 'addendum');
    for (const tool of ORCHESTRATION_TOOLS) expect(appended).toContain(tool);
    expect(prompt).not.toContain(IN_PLACE_ORCHESTRATOR_PROMPT);
  });

  it('inPlace (no git): the orchestrator gets the in-place section, a worker the in-place contract', async () => {
    const contexts: TranscriptContext[] = [];
    const reply = (context: TranscriptContext) => {
      contexts.push(context);
      return fauxAssistantMessage('ok');
    };
    faux.setResponses([reply, reply]);
    const orchestrator = await open({
      role: builtinRole(ORCHESTRATOR_ROLE_ID),
      host: orchestrationHost(),
      inPlace: true,
    });
    await orchestrator.session.prompt('Plan the work.');
    const worker = await open({
      role: role({ tools: 'all' }),
      workerHost: workerHost(),
      inPlace: true,
    });
    await worker.session.prompt('Do the task.');

    const [planned, worked] = contexts.map((context) => systemText(context));
    expect(count(planned ?? '', ORCHESTRATOR_PROMPT)).toBe(1);
    expect(count(planned ?? '', IN_PLACE_ORCHESTRATOR_PROMPT)).toBe(1);
    expect(worked).toContain(IN_PLACE_WORKER_CONTRACT_PROMPT);
    expect(worked).not.toContain(WORKER_CONTRACT_PROMPT);
    expect(worked).not.toContain(IN_PLACE_ORCHESTRATOR_PROMPT);
  });

  it('keeps follow-up feedback in the old run, but reopens the guard for an actual new prompt', async () => {
    const host = workerHost();
    const { session } = await open({ role: role({}), workerHost: host });
    const events: FynvraSessionEvent[] = [];
    subscribeNormalized(session, (event) => events.push(event));
    const report = (summary: string) =>
      fauxAssistantMessage(fauxToolCall('report_done', { outcome: 'succeeded', summary }), {
        stopReason: 'toolUse',
      });
    // Reproduce feedback arriving while report_done is still awaiting its Main result.
    host.reportDone.mockImplementationOnce(async () => {
      await session.prompt('Queued review feedback', { streamingBehavior: 'followUp' });
      return { ok: true };
    });
    faux.setResponses([report('first'), report('queued feedback'), fauxAssistantMessage('Stop')]);
    await session.prompt('Do the task');
    expect(host.reportDone).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === 'tool_end' && event.toolName === 'report_done')
    ).toEqual([
      expect.objectContaining({ isError: false }),
      expect.objectContaining({ isError: true }),
    ]);
    faux.setResponses([report('new run')]);
    await session.prompt('Feedback delivered after idle');
    expect(host.reportDone.mock.calls.map((call) => call[1])).toEqual(['first', 'new run']);
  });

  it('does not lose feedback submitted at the terminate/agent_settled boundary', async () => {
    const host = workerHost();
    const { session } = await open({ role: role({}), workerHost: host });
    const events: FynvraSessionEvent[] = [];
    subscribeNormalized(session, (event) => events.push(event));
    const report = (summary: string) =>
      fauxAssistantMessage(fauxToolCall('report_done', { outcome: 'succeeded', summary }), {
        stopReason: 'toolUse',
      });
    faux.setResponses([report('first'), report('retry at settle')]);
    let queued = false;
    session.subscribe((event) => {
      if (event.type !== 'agent_settled' || queued) return;
      queued = true;
      // Main can react to idle before the outer prompt promise returns. pi defers this to a new run.
      void session.prompt('Feedback at the idle boundary', { streamingBehavior: 'followUp' });
    });
    await session.prompt('First attempt');
    expect(host.reportDone.mock.calls.map((call) => call[1])).toEqual(['first', 'retry at settle']);
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(
      events.filter((event) => event.type === 'tool_end' && event.toolName === 'report_done')
    ).toEqual([
      expect.objectContaining({ isError: false }),
      expect.objectContaining({ isError: false }),
    ]);
    expect(events.filter((event) => event.type === 'agent_settled')).toHaveLength(2);
    expect(session.isIdle).toBe(true);
  });

  it('reopens report_done when a new run starts, e.g. after reject_work feedback', async () => {
    const host = workerHost();
    const { session } = await open({ role: role({}), workerHost: host });
    const report = (summary: string) =>
      fauxAssistantMessage(fauxToolCall('report_done', { outcome: 'succeeded', summary }), {
        stopReason: 'toolUse',
      });
    faux.setResponses([report('first'), report('after feedback')]);
    await session.prompt('Do the task.');
    await session.prompt('Review feedback: add a test, then report again.');
    expect(host.reportDone.mock.calls.map((call) => call[1])).toEqual(['first', 'after feedback']);
  });
});

describe('createRoleSession resources', () => {
  it('appends resolved instructions once to the actual model prompt, preserving project AGENTS loading', async () => {
    const cwd = path.join(tmp, 'instruction-project');
    await mkdir(cwd);
    await writeFile(path.join(cwd, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS_MARKER');
    const { session } = await open({
      cwd,
      role: role({ systemPrompt: 'ROLE_INSTRUCTIONS_MARKER' }),
      resourcePaths: {
        skills: [],
        mcpServers: [],
        instructionFile: {
          name: 'CLAUDE "custom".md',
          content: 'GLOBAL_INSTRUCTIONS_MARKER\nKeep source content.',
        },
      },
    });
    const prompts: string[] = [];
    const response = (context: TranscriptContext) => {
      prompts.push(systemText(context));
      return fauxAssistantMessage('ok');
    };
    faux.setResponses([response, response]);
    await session.prompt('first');
    await session.prompt('second');
    for (const prompt of prompts) {
      expect(prompt).toContain('PROJECT_INSTRUCTIONS_MARKER');
      expect(prompt).toContain('ROLE_INSTRUCTIONS_MARKER');
      expect(prompt).toContain(
        '<user_instructions source="CLAUDE &quot;custom&quot;.md">\nGLOBAL_INSTRUCTIONS_MARKER\nKeep source content.\n</user_instructions>'
      );
      expect(count(prompt, 'GLOBAL_INSTRUCTIONS_MARKER')).toBe(1);
    }
  });

  it('loads only the role skills and reports missing skill paths', async () => {
    const skillDir = path.join(tmp, 'skills', 'release-notes');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: release-notes\ndescription: Write release notes from the git log\n---\n\nUse git log.\n'
    );
    const { session, warnings } = await open({
      role: role({ skillIds: ['release-notes', 'missing'] }),
      resourcePaths: { skills: [skillDir, path.join(tmp, 'skills', 'missing')], mcpServers: [] },
    });
    const contexts: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage('ok');
      },
    ]);
    await session.prompt('hi');
    expect(systemText(contexts[0] as TranscriptContext)).toContain('release-notes');
    expect(warnings.join('\n')).toContain('does not exist');
  });

  it('registers role MCP servers through the pi MCP extension and warns about bad names', async () => {
    const { session, warnings, dispose } = await open({
      role: role({ mcpServerIds: ['docs', 'bad name'] }),
      resourcePaths: {
        skills: [],
        mcpServers: [
          { name: 'docs', command: 'fynvra-missing-mcp-server', enabled: false },
          { name: 'bad name', command: 'x' },
        ],
      },
    });
    expect(session.extensionRunner.getCommand('mcp')).toBeDefined();
    expect(warnings.join('\n')).toContain('"bad name" skipped');
    await dispose();
    await dispose();
  });
});

describe('command environment injection through real pi tools', () => {
  const shellTools = process.platform === 'win32' ? ['bash', 'powershell'] : ['bash'];

  // Production Main always chooses a local Windows shell instead of pi's PATH/WSL fallback.
  async function localBashFixture(): Promise<{ shellPath: string; powershell: boolean }> {
    if (process.platform !== 'win32') return { shellPath: '/bin/bash', powershell: false };
    const { stdout } = await promisify(execFile)('git', ['--exec-path'], {
      windowsHide: true,
      timeout: 5000,
    });
    const gitBash = path.resolve(stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');
    if (existsSync(gitBash)) return { shellPath: gitBash, powershell: false };
    return {
      shellPath: path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
      powershell: true,
    };
  }

  it.each(shellTools)(
    'injects %s subprocess env after session metadata, preserving default tool selection',
    async (name) => {
      const fixture = await localBashFixture();
      const powershell = name === 'powershell' || fixture.powershell;
      const script = path.join(workdir, "shell environment 'probe.cjs");
      await writeFile(
        script,
        'console.log(JSON.stringify({ proxy: process.env.HTTP_PROXY, session: process.env.PI_SESSION_ID, provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL }));'
      );
      const quote = (value: string) =>
        powershell
          ? `'${value.replace(/'/g, "''")}'`
          : `'${value.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
      const command = `${powershell ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`;
      const transform = vi.fn((env: NodeJS.ProcessEnv) => ({
        ...env,
        HTTP_PROXY: 'http://127.0.0.1:7890',
      }));
      const { session } = await open({
        role: role({ approvalMode: 'full' }),
        commandEnv: transform,
        settingsManager: SettingsManager.inMemory({
          shellPath: fixture.shellPath,
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
      });
      expect(session.getActiveToolNames().sort()).toEqual([
        'bash',
        'edit',
        'read',
        'web_fetch',
        'write',
      ]);
      session.setActiveToolsByName(['read', 'bash', 'powershell', 'edit', 'write']);
      const events: FynvraSessionEvent[] = [];
      const subscription = subscribeNormalized(session, (event) => events.push(event));
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(name, { command }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ]);
      await session.prompt('Inspect the test environment.');
      subscription.unsubscribe();
      expect(transform).toHaveBeenCalledTimes(1);
      const inherited = transform.mock.calls[0]?.[0];
      expect(inherited?.PI_SESSION_ID).toBe(session.sessionManager.getSessionId());
      expect(inherited?.PI_PROVIDER).toBe('fynvra-faux');
      expect(inherited?.PI_MODEL).toBe('faux-reasoner');
      expect(events.find((event) => event.type === 'tool_end')).toMatchObject({
        isError: false,
        output: expect.stringContaining(
          JSON.stringify({
            proxy: 'http://127.0.0.1:7890',
            session: session.sessionManager.getSessionId(),
            provider: 'fynvra-faux',
            model: 'faux-reasoner',
          })
        ),
      });
    }
  );
  it.each(shellTools)(
    'strips secrets from %s subprocess env in a restricted session only',
    async (name) => {
      const fixture = await localBashFixture();
      await writeFile(
        path.join(workdir, 'package.json'),
        JSON.stringify({ name: 'probe', private: true, scripts: { lint: 'node probe.cjs' } })
      );
      await writeFile(
        path.join(workdir, 'probe.cjs'),
        "console.log('token=' + (process.env.GITHUB_TOKEN ?? 'none'));"
      );
      vi.stubEnv('GITHUB_TOKEN', 'fake-token');
      try {
        for (const profile of ['restricted', undefined] as const) {
          const { session } = await open({
            role: role({ approvalMode: 'full' }),
            ...(profile ? { profile } : {}),
            settingsManager: SettingsManager.inMemory({
              shellPath: fixture.shellPath,
              retry: { enabled: false },
              compaction: { enabled: false },
            }),
          });
          session.setActiveToolsByName(['bash', 'powershell']);
          const events: FynvraSessionEvent[] = [];
          const subscription = subscribeNormalized(session, (event) => events.push(event));
          faux.setResponses([
            fauxAssistantMessage(fauxToolCall(name, { command: 'pnpm lint' }), {
              stopReason: 'toolUse',
            }),
            fauxAssistantMessage('done'),
          ]);
          await session.prompt('Run lint.');
          subscription.unsubscribe();
          const end = events.find((event) => event.type === 'tool_end');
          // 只比较探针输出的那一行，不打印完整环境变量
          const line = (end?.type === 'tool_end' ? String(end.output) : '').match(/token=\S+/)?.[0];
          expect(line).toBe(profile ? 'token=none' : 'token=fake-token');
        }
      } finally {
        vi.unstubAllEnvs();
        // workdir 在用例间共用：其他用例断言 package.json 不存在
        await rm(path.join(workdir, 'package.json'), { force: true });
        await rm(path.join(workdir, 'probe.cjs'), { force: true });
      }
    },
    60_000
  );
  it.each(['readonly', 'orchestrator'] as const)(
    'keeps %s permissions and injects git_readonly env',
    async (tools) => {
      const transform = vi.fn((env: NodeJS.ProcessEnv) => ({
        ...env,
        HTTP_PROXY: 'http://127.0.0.1:7890',
      }));
      const { session } = await open({
        role: role({ tools }),
        host: tools === 'orchestrator' ? orchestrationHost() : null,
        commandEnv: transform,
      });
      expect(session.getActiveToolNames()).not.toContain('bash');
      expect(session.getActiveToolNames()).not.toContain('powershell');
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('git_readonly', { args: ['status', '--short'] }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('done'),
      ]);
      await session.prompt('Read status.');
      expect(transform).toHaveBeenCalledTimes(1);
    }
  );
});

describe('createRoleSession approval gate', () => {
  /** 审批通道：按顺序给出决定（缺省 allow），记下每次请求 */
  function approver(...decisions: ApprovalDecision[]) {
    const requests: ApprovalGateRequest[] = [];
    const request = vi.fn<ApprovalRequestFn>(async (req) => {
      requests.push(req);
      return decisions.shift() ?? 'allow';
    });
    return { requests, request };
  }

  /** 模型依次发出这些工具调用，每次请求都记下上下文（含上一个工具结果），最后回一句话结束 */
  function script(...calls: { name: string; args: ToolCall['arguments'] }[]) {
    const contexts: TranscriptContext[] = [];
    faux.setResponses([
      ...calls.map((call, index) => (context: TranscriptContext) => {
        contexts.push(context);
        return fauxAssistantMessage(fauxToolCall(call.name, call.args, { id: `call-${index}` }), {
          stopReason: 'toolUse',
        });
      }),
      (context: TranscriptContext) => {
        contexts.push(context);
        return fauxAssistantMessage('done');
      },
    ]);
    return contexts;
  }

  /** 模型在这次请求里看到的最后一个工具结果 */
  function lastToolResult(context: TranscriptContext | undefined) {
    const result = context?.messages.filter((message) => message.role === 'toolResult').at(-1);
    if (result?.role !== 'toolResult') throw new Error('no tool result in the context');
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return { isError: result.isError, text };
  }

  it('asks before a supervised write and runs it once allowed', async () => {
    const approval = approver('allow');
    const { session } = await open({ role: role({ approvalMode: 'supervised' }), approval });
    const contexts = script({ name: 'write', args: { path: 'allowed.txt', content: 'hello' } });

    await session.prompt('Write the file.');

    expect(approval.requests).toEqual([
      {
        toolCallId: 'call-0',
        toolName: 'write',
        kind: 'file-write',
        title: 'write',
        detail: 'allowed.txt',
        args: { path: 'allowed.txt', content: 'hello' },
        expiresAt: expect.any(Number),
      },
    ]);
    expect(await readFile(path.join(workdir, 'allowed.txt'), 'utf8')).toBe('hello');
    expect(lastToolResult(contexts[1]).isError).toBe(false);
  });

  it('returns the refusal to the model and skips the tool when denied', async () => {
    const approval = approver('deny');
    const { session } = await open({ role: role({ approvalMode: 'supervised' }), approval });
    const contexts = script({ name: 'write', args: { path: 'denied.txt', content: 'nope' } });
    const events: FynvraSessionEvent[] = [];
    const subscription = subscribeNormalized(session, (event) => events.push(event));

    await session.prompt('Write the file.');
    subscription.unsubscribe();

    expect(existsSync(path.join(workdir, 'denied.txt'))).toBe(false);
    const seen = lastToolResult(contexts[1]);
    expect(seen.isError).toBe(true);
    expect(seen.text).toContain('The user denied writing denied.txt');
    expect(events.find((event) => event.type === 'tool_end')).toMatchObject({
      toolName: 'write',
      isError: true,
      output: expect.stringContaining('denied'),
    });
    // 拒绝不打断回合：模型拿到拒绝文本后继续回答
    expect(events.at(-1)).toMatchObject({ type: 'agent_settled', aborted: false });
  });

  it('lets auto-edits write files without asking but still asks about bash', async () => {
    const approval = approver('deny');
    const { session } = await open({ role: role({ approvalMode: 'auto-edits' }), approval });
    const contexts = script(
      { name: 'write', args: { path: 'auto.txt', content: 'auto' } },
      { name: 'bash', args: { command: 'echo hi > bash.txt' } }
    );

    await session.prompt('Write, then run a command.');

    expect(await readFile(path.join(workdir, 'auto.txt'), 'utf8')).toBe('auto');
    expect(approval.requests.map((request) => [request.kind, request.detail])).toEqual([
      ['command', 'echo hi > bash.txt'],
    ]);
    expect(existsSync(path.join(workdir, 'bash.txt'))).toBe(false);
    expect(lastToolResult(contexts[2]).text).toContain('The user denied the command `echo hi');
  });

  it('asks about protected commands in full mode and blocks them when denied', async () => {
    const approval = approver('deny');
    const transform = vi.fn((env: NodeJS.ProcessEnv) => ({
      ...env,
      HTTP_PROXY: 'http://127.0.0.1:7890',
    }));
    const { session } = await open({
      role: role({ approvalMode: 'full' }),
      approval,
      commandEnv: transform,
    });
    const contexts = script(
      { name: 'write', args: { path: 'full.txt', content: 'full' } },
      { name: 'bash', args: { command: 'git push origin main' } }
    );

    await session.prompt('Write, then push.');

    expect(await readFile(path.join(workdir, 'full.txt'), 'utf8')).toBe('full');
    expect(approval.requests).toEqual([
      expect.objectContaining({ kind: 'command', protectedAction: 'git push' }),
    ]);
    expect(lastToolResult(contexts[2]).text).toContain('protected action (git push)');
    expect(transform).not.toHaveBeenCalled();
  });

  it('remembers allowSession for the same kind and tool', async () => {
    const approval = approver('allowSession');
    const { session } = await open({ role: role({ approvalMode: 'supervised' }), approval });
    script(
      { name: 'write', args: { path: 'one.txt', content: '1' } },
      { name: 'write', args: { path: 'two.txt', content: '2' } }
    );

    await session.prompt('Write two files.');

    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(workdir, 'two.txt'), 'utf8')).toBe('2');
  });

  it('withdraws a pending approval when the run is aborted', async () => {
    let withdrawn: AbortSignal | undefined;
    const request = vi.fn<ApprovalRequestFn>(
      (_req, signal) =>
        new Promise<ApprovalDecision>(() => {
          withdrawn = signal;
        })
    );
    const { session } = await open({
      role: role({ approvalMode: 'supervised' }),
      approval: { request },
    });
    script({ name: 'write', args: { path: 'aborted.txt', content: 'x' } });

    const run = session.prompt('Write the file.');
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await session.abort();
    await run;

    expect(withdrawn?.aborted).toBe(true);
    expect(existsSync(path.join(workdir, 'aborted.txt'))).toBe(false);
  });

  it('denies calls that need approval when no approval channel is given (fail-closed)', async () => {
    const { session } = await open({ role: role({ approvalMode: 'auto-edits' }) });
    const contexts = script(
      { name: 'bash', args: { command: 'echo hi > unapproved.txt' } },
      { name: 'write', args: { path: 'unapproved-write.txt', content: 'ok' } }
    );

    await session.prompt('Run a command, then write.');

    expect(existsSync(path.join(workdir, 'unapproved.txt'))).toBe(false);
    expect(lastToolResult(contexts[1]).text).toContain('no approval channel');
    expect(await readFile(path.join(workdir, 'unapproved-write.txt'), 'utf8')).toBe('ok');
  });

  it('puts run_checks of a full orchestrator through the protected floor', async () => {
    const approval = approver('deny');
    const runChecks = vi.fn<OrchestrationHost['runChecks']>(async () => ({
      ok: true,
      exitCode: 0,
      output: 'ok',
      durationMs: 1,
    }));
    const { session } = await open({
      role: role({ id: 'orchestrator', tools: 'orchestrator', approvalMode: 'full' }),
      host: { ...orchestrationHost(), runChecks },
      approval,
    });
    script(
      { name: 'run_checks', args: { dispatch_id: 'dsp_1', command: 'pnpm test' } },
      { name: 'run_checks', args: { dispatch_id: 'dsp_1', command: 'pnpm test && git push' } }
    );

    await session.prompt('Check the work.');

    expect(approval.requests.map((request) => request.protectedAction)).toEqual(['git push']);
    expect(runChecks.mock.calls.map(([input]) => input.command)).toEqual(['pnpm test']);
  });
});

describe('createRoleSession profiles', () => {
  const configHost = { configure: async () => ({ ok: true as const }) };

  function triageHost() {
    return { triageReport: vi.fn(async () => ({ ok: true as const })) };
  }

  it('keeps fynvra_config for a session without a profile', async () => {
    const { session } = await open({ role: role({ tools: 'readonly' }), configHost });
    expect(session.getActiveToolNames()).toContain('fynvra_config');
  });

  it('gives triage only read / grep / find / ls and triage_report, whatever the role says', async () => {
    const { session } = await open({
      role: role({ tools: 'all', approvalMode: 'full' }),
      profile: 'triage',
      triageHost: triageHost(),
      configHost,
      workerHost: workerHost(),
      planMode: () => true,
    });
    expect(session.getActiveToolNames().sort()).toEqual(
      ['read', 'grep', 'find', 'ls', 'triage_report'].sort()
    );
  });

  it('refuses a triage session without a triage host', async () => {
    await expect(open({ role: role({}), profile: 'triage' })).rejects.toThrow('TriageHost');
  });

  it('gives triage the fixed prompt only and hands triage_report to the host', async () => {
    const host = triageHost();
    const { session } = await open({
      role: role({ systemPrompt: 'ROLE PROMPT MARKER' }),
      profile: 'triage',
      triageHost: host,
      resourcePaths: {
        skills: [],
        mcpServers: [],
        instructionFile: { name: 'AGENTS.md', content: 'USER INSTRUCTIONS MARKER' },
      },
    });
    const report = { kind: 'question', title: 't', summary: 's', reply: 'r' };
    const contexts: TranscriptContext[] = [];
    faux.setResponses([
      (context: TranscriptContext) => {
        contexts.push(context);
        return fauxAssistantMessage(fauxToolCall('triage_report', report, { id: 'call-0' }), {
          stopReason: 'toolUse',
        });
      },
      () => fauxAssistantMessage('done'),
    ]);
    await session.prompt('<untrusted-content>how do I start?</untrusted-content>');
    const prompt = systemText(contexts[0] as TranscriptContext);
    expect(prompt).toContain('# Fynvra triage');
    expect(prompt).not.toContain('ROLE PROMPT MARKER');
    expect(prompt).not.toContain('USER INSTRUCTIONS MARKER');
    expect(host.triageReport).toHaveBeenCalledWith(report, expect.anything());
  });

  it('gives a restricted session no fynvra_config and blocks protected writes without asking', async () => {
    const request = vi.fn<ApprovalRequestFn>(async () => 'allow');
    const { session } = await open({
      role: role({ tools: 'all', approvalMode: 'supervised' }),
      profile: 'restricted',
      configHost,
      approval: { request },
    });
    expect(session.getActiveToolNames()).not.toContain('fynvra_config');
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          fauxToolCall('write', { path: 'package.json', content: '{}' }, { id: 'call-0' }),
          { stopReason: 'toolUse' }
        ),
      () =>
        fauxAssistantMessage(
          fauxToolCall('write', { path: 'src/ok.ts', content: 'ok' }, { id: 'call-1' }),
          { stopReason: 'toolUse' }
        ),
      () => fauxAssistantMessage('done'),
    ]);
    await session.prompt('Edit the files.');
    expect(existsSync(path.join(workdir, 'package.json'))).toBe(false);
    expect(await readFile(path.join(workdir, 'src', 'ok.ts'), 'utf8')).toBe('ok');
    expect(request).not.toHaveBeenCalled();
  });

  it('gives a restricted orchestrator a merge_worktree that refuses without calling the host', async () => {
    const host = orchestrationHost();
    const merge = vi.spyOn(host, 'mergeWorktree');
    const { session } = await open({
      role: role({ id: 'orchestrator', tools: 'orchestrator', approvalMode: 'full' }),
      host,
      profile: 'restricted',
      configHost,
    });
    expect(session.getActiveToolNames()).not.toContain('fynvra_config');
    faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall('merge_worktree', { dispatch_id: 'd1' }, { id: 'c' }), {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage('done'),
    ]);
    await session.prompt('Merge it.');
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('createRoleSession profile language', () => {
  async function promptOf(options: Partial<CreateRoleSessionOptions> & { role: Role }) {
    const { session } = await open(options);
    let prompt = '';
    faux.setResponses([
      (context: TranscriptContext) => {
        prompt = systemText(context);
        return fauxAssistantMessage('ok');
      },
    ]);
    await session.prompt('hi');
    return prompt;
  }

  it('appends the language rule to triage and restricted sessions, without the instruction file', async () => {
    const resourcePaths = {
      skills: [],
      mcpServers: [],
      instructionFile: { name: 'AGENTS.md', content: 'USER INSTRUCTIONS MARKER' },
    };
    for (const language of ['Simplified Chinese', 'English']) {
      const prompts = [
        await promptOf({
          role: role({}),
          profile: 'triage',
          triageHost: { triageReport: async () => ({ ok: true }) },
          profileLanguage: language,
          resourcePaths,
        }),
        await promptOf({
          role: builtinRole(ORCHESTRATOR_ROLE_ID),
          host: orchestrationHost(),
          profile: 'restricted',
          profileLanguage: language,
          resourcePaths,
        }),
        await promptOf({
          role: role({ tools: 'all' }),
          workerHost: workerHost(),
          profile: 'restricted',
          profileLanguage: language,
          resourcePaths,
        }),
      ];
      for (const prompt of prompts) {
        expect(prompt).toContain(profileLanguagePrompt(language));
        expect(prompt).not.toContain('USER INSTRUCTIONS MARKER');
      }
    }
  });

  it('ignores the language for a session without a profile', async () => {
    const prompt = await promptOf({
      role: builtinRole(ORCHESTRATOR_ROLE_ID),
      host: orchestrationHost(),
      profileLanguage: 'English',
    });
    expect(prompt).not.toContain('# Output language');
  });
});

describe('createRoleSession profile search results', () => {
  function lastToolText(context: TranscriptContext | undefined): string {
    const result = context?.messages.filter((message) => message.role === 'toolResult').at(-1);
    if (result?.role !== 'toolResult') throw new Error('no tool result in the context');
    return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }

  async function search(options: Partial<CreateRoleSessionOptions> & { role: Role }) {
    await writeFile(path.join(workdir, '.env'), 'PASSWORD=hunter2\n');
    await mkdir(path.join(workdir, 'src'), { recursive: true });
    await writeFile(path.join(workdir, 'src', 'login.ts'), 'const PASSWORD_FIELD = 1;\n');
    const { session } = await open(options);
    const contexts: TranscriptContext[] = [];
    const calls: { name: string; args: ToolCall['arguments'] }[] = [
      { name: 'grep', args: { pattern: 'PASSWORD' } },
      { name: 'ls', args: {} },
    ];
    faux.setResponses([
      ...calls.map((call, index) => (context: TranscriptContext) => {
        contexts.push(context);
        return fauxAssistantMessage(fauxToolCall(call.name, call.args, { id: `call-${index}` }), {
          stopReason: 'toolUse',
        });
      }),
      (context: TranscriptContext) => {
        contexts.push(context);
        return fauxAssistantMessage('done');
      },
    ]);
    await session.prompt('Search.');
    await rm(path.join(workdir, '.env'), { force: true });
    return { grep: lastToolText(contexts[1]), ls: lastToolText(contexts[2]) };
  }

  it('hides committed sensitive files from triage grep and ls results', async () => {
    const { grep, ls } = await search({
      role: role({}),
      profile: 'triage',
      triageHost: { triageReport: async () => ({ ok: true }) },
    });
    expect(grep).toContain('src/login.ts');
    expect(grep).not.toContain('hunter2');
    expect(ls).toContain('src/');
    expect(ls).not.toContain('.env');
  });

  it('hides them for a restricted session too', async () => {
    const { grep, ls } = await search({
      role: role({ tools: 'readonly', approvalMode: 'full' }),
      profile: 'restricted',
    });
    expect(grep).toContain('src/login.ts');
    expect(ls).toContain('src/');
    expect(grep).not.toContain('hunter2');
    expect(ls).not.toContain('.env');
  });
});

describe('createRoleSession restricted coordinator', () => {
  const coordinator = () =>
    role({ id: 'orchestrator', tools: 'orchestrator', approvalMode: 'full' });

  it('drops git_readonly, web_fetch, write_plan and write_doc, which a normal coordinator keeps', async () => {
    const excluded = ['git_readonly', 'web_fetch', 'write_plan', 'write_doc'];
    const normal = await open({ role: coordinator(), host: orchestrationHost() });
    expect(normal.session.getActiveToolNames()).toEqual(expect.arrayContaining(excluded));
    const restricted = await open({
      role: coordinator(),
      host: orchestrationHost(),
      profile: 'restricted',
    });
    const active = restricted.session.getActiveToolNames();
    for (const name of excluded) expect(active).not.toContain(name);
    // open_pull_request 是受限会话唯一的交付方式
    expect(active).toEqual(
      expect.arrayContaining([
        'read',
        'dispatch_task',
        'review_diff',
        'open_pull_request',
        'merge_worktree',
      ])
    );
  });

  it('appends the restricted section to the coordinator prompt only for restricted sessions', async () => {
    const prompts: string[] = [];
    for (const profile of ['restricted', undefined] as const) {
      const { session } = await open({
        role: builtinRole(ORCHESTRATOR_ROLE_ID),
        host: orchestrationHost(),
        ...(profile ? { profile } : {}),
      });
      faux.setResponses([
        (context: TranscriptContext) => {
          prompts.push(systemText(context));
          return fauxAssistantMessage('ok');
        },
      ]);
      await session.prompt('hi');
    }
    const [restricted, normal] = prompts;
    expect(restricted).toContain(RESTRICTED_COORDINATOR_PROMPT.trim());
    // pnpm test 每个任务最多申请一次，被拒或超时不重试，直接用 open_pull_request 交付
    expect(RESTRICTED_COORDINATOR_PROMPT).toMatch(/request `pnpm test`.*at most once per task/);
    expect(RESTRICTED_COORDINATOR_PROMPT).toMatch(/do not retry; deliver with open_pull_request/);
    expect(RESTRICTED_COORDINATOR_PROMPT).toContain(
      "the pull request's CI checks run the tests and the build"
    );
    expect(restricted).toContain(ORCHESTRATOR_PROMPT.trim().split('\n')[0]);
    expect(normal).not.toContain('# Restricted session');
  });
});
