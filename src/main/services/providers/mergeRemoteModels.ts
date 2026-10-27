import type { ModelEntry, RemoteModelEntry } from '@shared/types/llm';

/** 已有模型与设置优先，远端新 id 按传入顺序追加；不把 alreadyAdded 存进注册表。 */
export function mergeRemoteModels(
  existing: readonly ModelEntry[],
  remote: readonly RemoteModelEntry[]
): { models: ModelEntry[]; added: number } {
  const models: ModelEntry[] = [];
  const ids = new Set<string>();
  for (const model of existing) {
    if (ids.has(model.id)) continue;
    ids.add(model.id);
    models.push({ ...model });
  }
  let added = 0;
  for (const { alreadyAdded: _alreadyAdded, ...model } of remote) {
    if (ids.has(model.id)) continue;
    ids.add(model.id);
    models.push(model);
    added += 1;
  }
  return { models, added };
}
