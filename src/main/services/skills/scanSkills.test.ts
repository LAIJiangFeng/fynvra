import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillEntry } from '@shared/types/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dedupeSkills,
  parseSkillCandidateId,
  readSkillRoot,
  resolveSkillCandidate,
  scanLocalSkills,
  skillRoots,
} from './scanSkills';

let home: string;

const skill = (root: string, dir: string, frontmatter: string | null) => {
  const path = join(home, root, dir);
  mkdirSync(path, { recursive: true });
  if (frontmatter !== null)
    writeFileSync(join(path, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${dir}\n`);
  return path;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fynvra-skills-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('定位：skillRoots', () => {
  it('依次是 Claude Code、Codex、pi 的技能目录', () => {
    expect(skillRoots(home)).toEqual([
      { source: 'claude', label: 'Claude Code', root: join(home, '.claude', 'skills') },
      { source: 'codex', label: 'Codex', root: join(home, '.codex', 'skills') },
      { source: 'pi', label: 'pi', root: join(home, '.pi', 'agent', 'skills') },
    ]);
  });
});

describe('读取：readSkillRoot', () => {
  it('只收含 SKILL.md 的子目录，跳过隐藏目录与普通文件，按目录名排序', async () => {
    skill('.claude/skills', 'zeta', 'name: zeta\ndescription: Z');
    skill('.claude/skills', 'alpha', 'description: no name');
    skill('.claude/skills', 'no-manifest', null);
    skill('.claude/skills', '.system', 'name: hidden');
    writeFileSync(join(home, '.claude', 'skills', 'README.md'), '# notes');

    const result = await readSkillRoot(join(home, '.claude', 'skills'));
    expect(result).toEqual({
      status: 'found',
      skills: [
        {
          dir: 'alpha',
          name: 'alpha',
          description: 'no name',
          path: join(home, '.claude', 'skills', 'alpha'),
        },
        {
          dir: 'zeta',
          name: 'zeta',
          description: 'Z',
          path: join(home, '.claude', 'skills', 'zeta'),
        },
      ],
    });
  });

  it('目录不存在是 not-found；根路径是文件时是 error', async () => {
    expect(await readSkillRoot(join(home, 'missing'))).toEqual({ status: 'not-found', skills: [] });
    writeFileSync(join(home, 'file'), '');
    expect(await readSkillRoot(join(home, 'file'))).toMatchObject({ status: 'error', skills: [] });
  });
});

describe('去重：dedupeSkills', () => {
  const found = (source: 'claude' | 'codex' | 'pi', name: string, dir = name) => ({
    source,
    skills: [{ dir, name, path: `/home/u/${source}/${dir}` }],
  });

  it('按小写 name 去重，先出现的来源优先', () => {
    const candidates = dedupeSkills(
      [found('claude', 'PDF', 'pdf'), found('codex', 'grill-me'), found('pi', 'pdf', 'pdf-copy')],
      []
    );
    expect(candidates).toEqual([
      {
        id: 'claude:pdf',
        source: 'claude',
        name: 'PDF',
        path: '/home/u/claude/pdf',
        registered: false,
      },
      {
        id: 'codex:grill-me',
        source: 'codex',
        name: 'grill-me',
        path: '/home/u/codex/grill-me',
        registered: false,
      },
    ]);
  });

  it('已登记同名（不区分大小写）或同目录的技能标记 registered', () => {
    const registered: SkillEntry[] = [
      { id: 'pdf', name: 'pdf', path: '/elsewhere/pdf', enabled: true },
      { id: 'x', name: 'renamed', path: '/home/u/codex/grill-me', enabled: true },
    ];
    const candidates = dedupeSkills(
      [found('claude', 'PDF', 'pdf'), found('codex', 'grill-me')],
      registered
    );
    expect(candidates.map((candidate) => candidate.registered)).toEqual([true, true]);
  });
});

describe('scanLocalSkills', () => {
  it('单个来源失败不影响其他来源', async () => {
    skill('.claude/skills', 'pdf', 'name: pdf');
    // 根目录本身是文件：readdir 报 ENOTDIR（中间段是文件时 Windows 报 ENOENT，不能用来造错误）
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'skills'), 'not a directory');
    skill('.pi/agent/skills', 'pdf', 'name: PDF');
    skill('.pi/agent/skills', 'web', 'name: web');

    const result = await scanLocalSkills({ home, registered: [] });
    expect(result.sources.map(({ source, status, count }) => ({ source, status, count }))).toEqual([
      { source: 'claude', status: 'found', count: 1 },
      { source: 'codex', status: 'error', count: 0 },
      { source: 'pi', status: 'found', count: 2 },
    ]);
    expect(result.sources[1]?.error).toBeTruthy();
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['claude:pdf', 'pi:web']);
  });
});

describe('候选 id', () => {
  it('parseSkillCandidateId 只接受 <来源>:<单段目录名>', () => {
    expect(parseSkillCandidateId('claude:pdf')).toEqual({ source: 'claude', dir: 'pdf' });
    expect(parseSkillCandidateId('pi:a:b')).toEqual({ source: 'pi', dir: 'a:b' });
    for (const bad of [
      '',
      'pdf',
      'cursor:pdf',
      'claude:',
      'claude:..',
      'claude:.',
      'claude:a/b',
      'claude:a\\b',
      1,
    ]) {
      expect(parseSkillCandidateId(bad)).toBeNull();
    }
  });

  it('resolveSkillCandidate 把候选 id 还原成固定根目录下的路径', () => {
    expect(resolveSkillCandidate('codex:grill-me', home)).toBe(
      join(home, '.codex', 'skills', 'grill-me')
    );
    expect(resolveSkillCandidate('codex:../../etc', home)).toBeNull();
  });
});
