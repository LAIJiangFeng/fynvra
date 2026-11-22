import { describe, expect, it } from 'vitest';
import { gitHostOf, pluginSourceIconKind } from './pluginSource';

describe('gitHostOf', () => {
  it.each([
    ['git:github.com/o/r', 'github.com'],
    ['git:git@github.com:o/r', 'github.com'],
    ['https://github.com/o/r', 'github.com'],
    ['https://www.GitHub.com/o/r.git', 'github.com'],
    ['http://gitlab.com/o/r', 'gitlab.com'],
    ['ssh://git@gitlab.com/o/r', 'gitlab.com'],
    ['ssh://git@git.example.com:2222/o/r', 'git.example.com'],
    ['git+https://github.com/o/r.git', 'github.com'],
    ['git@gitlab.com:o/r', 'gitlab.com'],
  ])('%s → %s', (source, host) => {
    expect(gitHostOf(source)).toBe(host);
  });

  it.each(['', 'git:', 'not a url', 'npm:foo'])('解析不出：%s', (source) => {
    expect(gitHostOf(source)).toBeUndefined();
  });
});

describe('pluginSourceIconKind', () => {
  it('按来源和分级取图标', () => {
    expect(pluginSourceIconKind({ tier: 'official' })).toBe('official');
    expect(pluginSourceIconKind({ tier: 'reviewed' })).toBe('person');
    expect(pluginSourceIconKind({})).toBe('person');
    expect(pluginSourceIconKind({ kind: 'local' })).toBe('local');
    expect(pluginSourceIconKind({ kind: 'npm', source: 'npm:foo' })).toBe('npm');
    expect(pluginSourceIconKind({ kind: 'git', source: 'git:github.com/o/r' })).toBe('github');
    expect(pluginSourceIconKind({ kind: 'git', source: 'git@gitlab.com:o/r' })).toBe('gitlab');
    expect(pluginSourceIconKind({ kind: 'git', source: 'https://git.example.com/o/r' })).toBe(
      'git'
    );
    expect(pluginSourceIconKind({ kind: 'market', tier: 'official' })).toBe('official');
    expect(pluginSourceIconKind({ kind: 'market', tier: 'reviewed' })).toBe('person');
    expect(pluginSourceIconKind({ kind: 'market' })).toBe('market');
  });
});
