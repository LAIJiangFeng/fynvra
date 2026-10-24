import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@shared/guards';
import type { SkillEntry } from '@shared/types/llm';
import type {
  SkillCandidate,
  SkillScanSource,
  SkillSourceId,
} from '../../../preload/domains/skills';
import { samePath } from '../gitRepository';
import { readSkillManifest } from './skillManifest';

// skills:scan 分三层：定位（skillRoots）→ 读取（readSkillRoot）→ 去重（dedupeSkills）。
// 每层都可单测；单个来源读失败只记在它自己的 status 上，不影响其他来源。

export interface SkillRoot {
  source: SkillSourceId;
  label: string;
  root: string;
}

/** 定位：本机已知的技能根目录。顺序就是去重时的优先级。 */
export function skillRoots(home: string): SkillRoot[] {
  return [
    { source: 'claude', label: 'Claude Code', root: join(home, '.claude', 'skills') },
    { source: 'codex', label: 'Codex', root: join(home, '.codex', 'skills') },
    { source: 'pi', label: 'pi', root: join(home, '.pi', 'agent', 'skills') },
  ];
}

export interface DiscoveredSkill {
  /** 根目录下的目录名，组成候选 id */
  dir: string;
  name: string;
  description?: string;
  path: string;
}

export interface SkillRootReport {
  status: SkillScanSource['status'];
  skills: DiscoveredSkill[];
  error?: string;
}

/**
 * 读取：根目录下每个含 SKILL.md 的子目录，按目录名排序。直接尝试读 `<dir>/SKILL.md` 而不先判断类型，
 * 这样会跟随符号链接（技能常以链接装进 ~/.claude/skills）；隐藏目录跳过。
 */
export async function readSkillRoot(root: string): Promise<SkillRootReport> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'not-found', skills: [] }
      : { status: 'error', skills: [], error: errorMessage(error) };
  }
  const dirs = names.filter((name) => !name.startsWith('.')).sort();
  const manifests = await Promise.all(dirs.map((dir) => readSkillManifest(join(root, dir))));
  const skills: DiscoveredSkill[] = [];
  for (const [index, result] of manifests.entries()) {
    const dir = dirs[index];
    if (!result.ok || dir === undefined) continue;
    const { name, description } = result.manifest;
    skills.push({ dir, name, ...(description ? { description } : {}), path: join(root, dir) });
  }
  return { status: 'found', skills };
}

/**
 * 去重：按小写 name，先出现的来源优先（pi 不允许同名技能共存）。
 * 已登记了同名或同目录技能的候选标记 registered，界面上不再默认勾选。
 */
export function dedupeSkills(
  sources: ReadonlyArray<{ source: SkillSourceId; skills: readonly DiscoveredSkill[] }>,
  registered: readonly SkillEntry[],
  platform: NodeJS.Platform = process.platform
): SkillCandidate[] {
  const registeredNames = new Set(registered.map((entry) => entry.name.trim().toLowerCase()));
  const seen = new Set<string>();
  const candidates: SkillCandidate[] = [];
  for (const { source, skills } of sources) {
    for (const skill of skills) {
      const key = skill.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        id: `${source}:${skill.dir}`,
        source,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        path: skill.path,
        registered:
          registeredNames.has(key) ||
          registered.some((entry) => samePath(entry.path, skill.path, platform)),
      });
    }
  }
  return candidates;
}

export async function scanLocalSkills(options: {
  home: string;
  registered: readonly SkillEntry[];
}): Promise<{ candidates: SkillCandidate[]; sources: SkillScanSource[] }> {
  const roots = skillRoots(options.home);
  const reports = await Promise.all(
    roots.map((root) =>
      readSkillRoot(root.root).catch(
        (error): SkillRootReport => ({ status: 'error', skills: [], error: errorMessage(error) })
      )
    )
  );
  const sources = roots.map((root, index): SkillScanSource => {
    const report = reports[index] ?? { status: 'error', skills: [] };
    return {
      ...root,
      status: report.status,
      count: report.skills.length,
      ...(report.error ? { error: report.error } : {}),
    };
  });
  const candidates = dedupeSkills(
    roots.map((root, index) => ({ source: root.source, skills: reports[index]?.skills ?? [] })),
    options.registered
  );
  return { candidates, sources };
}

const CANDIDATE_ID = /^(claude|codex|pi):(.+)$/;
const MAX_CANDIDATE_ID_LENGTH = 300;

/** 候选 id `<来源>:<目录名>`：目录名必须是单段（不含分隔符、不是 . / ..），只能指向根目录的直接子目录。 */
export function parseSkillCandidateId(raw: unknown): { source: SkillSourceId; dir: string } | null {
  if (typeof raw !== 'string' || raw.length > MAX_CANDIDATE_ID_LENGTH) return null;
  const match = CANDIDATE_ID.exec(raw);
  const dir = match?.[2];
  if (!match || dir === undefined || dir === '.' || dir === '..' || /[\\/\0]/.test(dir))
    return null;
  return { source: match[1] as SkillSourceId, dir };
}

/** 候选 id → 固定根目录下的技能目录；Renderer 只回传 id，路径由 Main 重新拼出。 */
export function resolveSkillCandidate(id: unknown, home: string): string | null {
  const parsed = parseSkillCandidateId(id);
  const root = parsed && skillRoots(home).find((candidate) => candidate.source === parsed.source);
  return parsed && root ? join(root.root, parsed.dir) : null;
}
