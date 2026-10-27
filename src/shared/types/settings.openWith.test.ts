import { describe, expect, it } from 'vitest';
import { parseOpenWithApps, parsePreferences, parsePreferencesPatch } from './settings';

const app = { id: 'custom-editor', name: 'My editor', path: 'C:\\Apps\\My Editor.exe' };

describe('openWithApps preferences', () => {
  it('keeps portable, short application metadata and omits an unset preference', () => {
    const apps = [
      app,
      { id: 'mac', name: 'Editor', path: '/Applications/Editor.app' },
      { id: 'unc', name: 'Shared', path: '\\\\host\\share\\editor.exe' },
    ];
    expect(parsePreferences({ openWithApps: apps }).openWithApps).toEqual(apps);
    expect(parsePreferencesPatch({ openWithApps: apps })).toEqual({ openWithApps: apps });
    expect(parsePreferences({}).openWithApps).toBeUndefined();
    expect(parsePreferencesPatch({ openWithApps: [] })).toEqual({ openWithApps: [] });
  });

  it('drops junk, duplicates, reserved ids, relative paths and oversized/control-character strings', () => {
    const junk = [
      null,
      42,
      {},
      { ...app, name: '' },
      { ...app, name: '   ' },
      { ...app, name: 'x'.repeat(101) },
      { ...app, name: 'line\nbreak' },
      { ...app, path: 'editor.exe' },
      { ...app, path: 'C:editor.exe' },
      { ...app, path: '/bin/editor\0' },
      { ...app, path: `/${'x'.repeat(4096)}` },
      { ...app, id: 'vscode' },
      { ...app, id: 'explorer' },
      { ...app, id: '../bin' },
    ];
    expect(parseOpenWithApps([...junk, app, app])).toEqual([app]);
    expect(parseOpenWithApps({ app })).toEqual([]);
    for (const value of junk) expect(parsePreferencesPatch({ openWithApps: [value] })).toBeNull();
    expect(parsePreferencesPatch({ openWithApps: [app, app] })).toBeNull();
    expect(parsePreferencesPatch({ openWithApps: 'bad' })).toBeNull();
  });

  it('limits loaded apps to 20 and rejects an oversized update without truncating it', () => {
    const apps = Array.from({ length: 21 }, (_, index) => ({ ...app, id: `custom-${index}` }));
    expect(parsePreferences({ openWithApps: apps }).openWithApps).toEqual(apps.slice(0, 20));
    expect(parsePreferencesPatch({ openWithApps: apps })).toBeNull();
    expect(parsePreferencesPatch({ openWithApps: apps.slice(0, 20) })).not.toBeNull();
  });
});
