import { asRecord } from '@shared/guards';
import type { SkillEntry } from '@shared/types/llm';
import { translate } from '../../i18n';
import { samePath } from '../gitRepository';
import { createJsonRegistry, isRegistryId, toSlug, uniqueId } from '../providers/jsonRegistry';

export interface SkillToRegister {
  name: string;
  description?: string;
  path: string;
}

export interface SkillRegistry {
  list(): Promise<SkillEntry[]>;
  /** 登记技能目录（只存引用）。同名（不区分大小写）或同目录的跳过，批内也去重；新登记的默认启用。 */
  add(skills: readonly SkillToRegister[]): Promise<{ added: SkillEntry[]; skipped: string[] }>;
  /** 只从注册表移除，不动磁盘；id 不存在时返回 false。 */
  remove(id: string): Promise<boolean>;
  /** id 不存在时返回 undefined。 */
  setEnabled(id: string, enabled: boolean): Promise<SkillEntry | undefined>;
}

/** `userData/skills.json`：技能目录的引用注册表，内容留在原处。 */
export function createSkillRegistry(options: {
  filePath: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}): SkillRegistry {
  const { platform = process.platform, ...file } = options;
  const registry = createJsonRegistry<SkillEntry>({
    ...file,
    key: 'skills',
    parseEntry: parseStoredSkill,
  });

  return {
    list: () => registry.list(),
    add: (skills) =>
      registry.transact((entries) => {
        const next = [...entries];
        const added: SkillEntry[] = [];
        const skipped: string[] = [];
        for (const skill of skills) {
          const name = skill.name.trim();
          if (next.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
            skipped.push(translate('skills.sameName', { name }));
            continue;
          }
          const sameDir = next.find((entry) => samePath(entry.path, skill.path, platform));
          if (sameDir) {
            skipped.push(translate('skills.sameDir', { name, other: sameDir.name }));
            continue;
          }
          const entry: SkillEntry = {
            id: uniqueId(
              toSlug(name, 'skill'),
              next.map((existing) => existing.id)
            ),
            name,
            path: skill.path,
            ...(skill.description ? { description: skill.description } : {}),
            enabled: true,
          };
          next.push(entry);
          added.push(entry);
        }
        return { ...(added.length > 0 ? { next } : {}), result: { added, skipped } };
      }),
    remove: (id) =>
      registry.transact((entries) => {
        const next = entries.filter((entry) => entry.id !== id);
        return next.length === entries.length ? { result: false } : { next, result: true };
      }),
    setEnabled: (id, enabled) =>
      registry.transact((entries) => {
        const index = entries.findIndex((entry) => entry.id === id);
        const current = entries[index];
        if (!current) return { result: undefined };
        const updated = { ...current, enabled };
        return { next: entries.with(index, updated), result: updated };
      }),
  };
}

/** 磁盘记录宽松收窄：id / 名称 / 路径不合法整条丢弃，enabled 缺省为 true。 */
export function parseStoredSkill(raw: unknown): SkillEntry | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, name, path, description, enabled } = record;
  if (!isRegistryId(id) || typeof name !== 'string' || !name.trim()) return null;
  if (typeof path !== 'string' || !path) return null;
  return {
    id,
    name: name.trim(),
    path,
    ...(typeof description === 'string' && description ? { description } : {}),
    enabled: typeof enabled === 'boolean' ? enabled : true,
  };
}
