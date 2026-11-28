import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { GitRunner } from '../gitRepository';
import { type MemoryDb, transaction } from './db';

// 工作区 → 项目标识（ARCHITECTURE §7.15「项目标识」）。工作区信息由调用方传入，不 import 工作区服务。

export interface MemoryWorkspace {
  id: string;
  path: string;
  vcs: 'git' | 'none';
}

const GIT_TIMEOUT_MS = 5_000;

/** 非 git 目录：`dir:<真实路径 sha256 前 16 位>`；Windows 上先转小写、统一 `/` */
export async function dirProjectKey(
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  let real = await realpath(path).catch(() => path);
  if (platform === 'win32') real = real.toLowerCase().replace(/\\/g, '/');
  return `dir:${createHash('sha256').update(real).digest('hex').slice(0, 16)}`;
}

/** 根提交排序后的第一个；解析失败返回 undefined */
async function gitProjectKey(runGit: GitRunner, cwd: string): Promise<string | undefined> {
  const result = await runGit(['rev-list', '--max-parents=0', 'HEAD'], cwd, {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!result.ok) return undefined;
  const roots = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40,64}$/i.test(line))
    .sort();
  return roots.length > 0 ? `git:${roots[0].toLowerCase()}` : undefined;
}

export function cachedProjectKey(db: MemoryDb, workspaceId: string): string | undefined {
  const row = db
    .prepare('SELECT project_key FROM workspace_projects WHERE workspace_id = ?')
    .get(workspaceId) as { project_key: string } | undefined;
  return row?.project_key;
}

function cache(db: MemoryDb, workspaceId: string, projectKey: string, at: number): void {
  db.prepare(
    `INSERT INTO workspace_projects (workspace_id, project_key, resolved_at) VALUES (?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET project_key = excluded.project_key, resolved_at = excluded.resolved_at`
  ).run(workspaceId, projectKey, at);
}

/** 同一 project_key 的其他工作区 */
export function workspacesSharing(
  db: MemoryDb,
  projectKey: string,
  exceptWorkspaceId?: string
): string[] {
  const rows = db
    .prepare(
      'SELECT workspace_id FROM workspace_projects WHERE project_key = ? ORDER BY workspace_id'
    )
    .all(projectKey) as { workspace_id: string }[];
  return rows.map((row) => row.workspace_id).filter((id) => id !== exceptWorkspaceId);
}

/** dir → git 换键：一个事务里把旧键的条目搬到新键（内容哈希冲突的旧条目丢弃）并更新缓存 */
function rekey(db: MemoryDb, workspaceId: string, from: string, to: string, at: number): void {
  transaction(db, () => {
    db.prepare(
      `DELETE FROM memories WHERE project_key = ?
         AND content_hash IN (SELECT content_hash FROM memories WHERE project_key = ?)`
    ).run(from, to);
    db.prepare('UPDATE memories SET project_key = ? WHERE project_key = ?').run(to, from);
    cache(db, workspaceId, to, at);
  });
}

/**
 * 解析工作区的项目标识。git：根提交 → `git:<sha>` 并缓存；解析失败沿用缓存，从未成功过才退到不缓存的 dir 标识。
 * 非 git：dir 标识并缓存。
 */
export async function resolveProjectKey(
  db: MemoryDb,
  workspace: MemoryWorkspace,
  deps: { runGit: GitRunner; now: () => number; platform?: NodeJS.Platform }
): Promise<string> {
  const cached = cachedProjectKey(db, workspace.id);
  if (workspace.vcs === 'none') {
    const key = await dirProjectKey(workspace.path, deps.platform);
    if (cached !== key) cache(db, workspace.id, key, deps.now());
    return key;
  }
  const key = await gitProjectKey(deps.runGit, workspace.path);
  if (!key) return cached ?? dirProjectKey(workspace.path, deps.platform);
  if (cached === key) return key;
  if (cached?.startsWith('dir:')) {
    // 旧键还被别的工作区共用时不换键，继续用旧键
    if (workspacesSharing(db, cached, workspace.id).length > 0) return cached;
    rekey(db, workspace.id, cached, key, deps.now());
    return key;
  }
  cache(db, workspace.id, key, deps.now());
  return key;
}
