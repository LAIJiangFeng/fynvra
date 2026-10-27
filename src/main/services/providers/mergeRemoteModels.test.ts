import type { ModelEntry, RemoteModelEntry } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import { mergeRemoteModels } from './mergeRemoteModels';

const remote = (id: string, extra: Partial<RemoteModelEntry> = {}): RemoteModelEntry => ({
  id,
  name: id,
  alreadyAdded: false,
  ...extra,
});

describe('mergeRemoteModels', () => {
  it('保留已有模型顺序和全部设置，新 id 按远端列表顺序追加，去掉重复 id', () => {
    const existing: ModelEntry[] = [
      { id: 'z', name: 'Custom Z', contextWindow: 1234, maxOutput: 512, reasoning: false },
      { id: 'a', name: 'Custom A' },
      { id: 'z', name: 'Duplicate Z' },
    ];
    const fetched = [
      remote('a', { name: 'Remote A', reasoning: true }),
      remote('new-z', { contextWindow: 8192, maxOutput: 2048, reasoning: true }),
      remote('z', { name: 'Remote Z', contextWindow: 9999, reasoning: true }),
      remote('new-a', { alreadyAdded: true, reasoning: false }),
      remote('new-z', { name: 'Duplicate new Z' }),
    ];
    const before = structuredClone({ existing, fetched });
    const result = mergeRemoteModels(existing, fetched);
    expect(result).toEqual({
      added: 2,
      models: [
        existing[0],
        existing[1],
        { id: 'new-z', name: 'new-z', contextWindow: 8192, maxOutput: 2048, reasoning: true },
        { id: 'new-a', name: 'new-a', reasoning: false },
      ],
    });
    expect({ existing, fetched }).toEqual(before);
    expect(result.models.every((model) => !('alreadyAdded' in model))).toBe(true);
  });

  it('空列表与重复拉取不会删除或改写已有模型', () => {
    const existing = [{ id: 'kept', name: 'Kept' }];
    expect(mergeRemoteModels(existing, [])).toEqual({ models: existing, added: 0 });
    expect(mergeRemoteModels(existing, [remote('kept')])).toEqual({
      models: existing,
      added: 0,
    });
    expect(mergeRemoteModels([], [remote('new'), remote('new')])).toEqual({
      models: [{ id: 'new', name: 'new' }],
      added: 1,
    });
    expect(mergeRemoteModels([], [])).toEqual({ models: [], added: 0 });
  });
});
