import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsFile } from '../settingsFile';
import { createLastModelStore } from './lastModels';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function settingsIn(content?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'fynvra-last-models-'));
  dirs.push(dir);
  const filePath = join(dir, 'settings.json');
  if (content !== undefined) writeFileSync(filePath, JSON.stringify(content));
  const settings = createSettingsFile({ filePath, debounceMs: 60_000 });
  return { settings, filePath };
}

describe('createLastModelStore', () => {
  it('remembers the last model per workspace in settings.json preferences, ids only', () => {
    const { settings, filePath } = settingsIn({
      preferences: { theme: 'dark', sidePanelOpen: false },
      workspaces: [],
    });
    const store = createLastModelStore(settings);
    expect(store.get('ws-1')).toBeUndefined();

    store.set('ws-1', { providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'high' });
    store.set('ws-2', { providerId: 'openai', modelId: 'gpt-5.5' });
    store.set('ws-1', { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' });
    expect(store.get('ws-1')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      thinking: 'xhigh',
    });
    expect(settings.flush()).toBe(true);

    const preferences = JSON.parse(readFileSync(filePath, 'utf8')).preferences;
    expect(preferences).toEqual({
      theme: 'dark',
      sidePanelOpen: false,
      lastModelByWorkspace: {
        'ws-1': { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' },
        'ws-2': { providerId: 'openai', modelId: 'gpt-5.5' },
      },
    });
  });

  it('keeps only id references even when handed a wider object', () => {
    const { settings } = settingsIn();
    const store = createLastModelStore(settings);
    const wider = { providerId: 'openai', modelId: 'gpt-5.5', apiKey: 'sk-secret' };
    store.set('ws-1', wider);
    expect(JSON.stringify(settings.read())).not.toContain('sk-secret');
  });

  it('does not read inherited keys as a workspace entry', () => {
    const { settings } = settingsIn();
    expect(createLastModelStore(settings).get('toString')).toBeUndefined();
  });
});
