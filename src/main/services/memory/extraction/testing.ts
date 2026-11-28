// 测试用（只被 *.test.ts 引用）：临时目录里的真实记忆服务，w1 是一个 git 项目。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryPreferences } from '@shared/types/settings';
import type { AcceptedTask } from '../../orchestration/service';
import { createMemoryService, type MemoryProjectHandle, type MemoryService } from '../index';

export const SECRET = 'known-secret-value-1';

export interface MemoryFixture {
  dir: string;
  service: MemoryService;
  prefs: MemoryPreferences;
  project(): Promise<MemoryProjectHandle>;
  close(): Promise<void>;
}

export function createMemoryFixture(): MemoryFixture {
  const dir = mkdtempSync(join(tmpdir(), 'fynvra-extraction-'));
  const fixture = {
    dir,
    prefs: { enabled: true, autoExtract: true, expireDays: 28 } as MemoryPreferences,
  } as MemoryFixture;
  fixture.service = createMemoryService({
    dbPath: join(dir, 'memory', 'memory.db'),
    runGit: async () => ({ ok: true, stdout: `${'a'.repeat(40)}\n` }),
    preferences: () => ({ memory: fixture.prefs }),
    workspace: (id) => (id === 'w1' ? { path: join(dir, 'w1'), vcs: 'git' } : undefined),
    recentUserMessages: async () => [],
    knownSecrets: async () => [SECRET],
  });
  fixture.project = async () => {
    const project = await fixture.service.openProject('w1');
    if ('error' in project) throw new Error(project.error);
    return project;
  };
  fixture.close = async () => {
    (await fixture.service.database())?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return fixture;
}

export function acceptedTask(over: Partial<AcceptedTask> = {}): AcceptedTask {
  return {
    workspaceId: 'w1',
    runId: 'r1',
    coordinatorSessionId: 's-main',
    coordinatorRestricted: false,
    acceptedVia: 'merge',
    acceptedAt: 1,
    task: {
      id: 't1',
      title: 'Fix build script',
      spec: 'Make pnpm build work on Windows.',
      workflow: false,
      mergedDiff: { baseCommit: 'b', headCommit: 'h' },
    },
    dispatches: [
      {
        dispatchId: 'd1',
        sessionId: 's-worker',
        status: 'succeeded',
        startedAt: 0,
        summary: 'Build now uses cross-env.',
        filesModified: ['package.json'],
      },
    ],
    reviewFeedback: [],
    ...over,
  };
}
