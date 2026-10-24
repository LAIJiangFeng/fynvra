import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Role } from '../coreTypes';
import { type FynvraSessionEvent, subscribeNormalized } from '../events/normalize';
import { ORCHESTRATION_TOOL_METHODS, type OrchestrationHost, type WorkerHost } from '../host';
import { ORCHESTRATOR_PROMPT, WORKER_CONTRACT_PROMPT } from '../prompts/orchestratorPrompt';
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

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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
  it('gives the orchestrator only read-only and orchestration tools', async () => {
    const { session } = await open({
      role: role({ id: 'orchestrator', tools: 'orchestrator', approvalMode: 'full' }),
      host: orchestrationHost(),
    });
    expect(session.getActiveToolNames().sort()).toEqual(
      [...READONLY_TOOLS, ...ORCHESTRATION_TOOLS].sort()
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
      [...READONLY_TOOLS, 'ask_coordinator', 'report_done'].sort()
    );
  });

  it('gives an all-tools worker the pi default tools plus the worker tools', async () => {
    const { session } = await open({ role: role({ tools: 'all' }), workerHost: workerHost() });
    const active = session.getActiveToolNames();
    expect(active).toEqual(expect.arrayContaining(['read', 'edit', 'write', 'report_done']));
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

  it('appends the orchestrator prompt once, however many runs follow', async () => {
    const { session } = await open({
      role: role({
        id: 'orchestrator',
        tools: 'orchestrator',
        systemPrompt: 'ORCHESTRATOR_ROLE_MARKER',
      }),
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
    expect(count(prompt, 'ORCHESTRATOR_ROLE_MARKER')).toBe(1);
    expect(count(prompt, 'Never modify code yourself')).toBe(2); // 标题与正文各一次
    expect(prompt).not.toContain(WORKER_CONTRACT_PROMPT);
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
