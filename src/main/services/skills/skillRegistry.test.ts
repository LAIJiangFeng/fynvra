import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillRegistry, parseStoredSkill } from './skillRegistry';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-skill-registry-'));
  filePath = join(dir, 'skills.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createSkillRegistry', () => {
  it('登记引用（不复制内容）：id 由名称生成，默认启用', async () => {
    const registry = createSkillRegistry({ filePath });
    const result = await registry.add([
      { name: 'PDF Tools', description: 'Read PDFs', path: '/skills/pdf' },
      { name: '中文技能', path: '/skills/zh' },
    ]);
    expect(result).toEqual({
      added: [
        {
          id: 'pdf-tools',
          name: 'PDF Tools',
          path: '/skills/pdf',
          description: 'Read PDFs',
          enabled: true,
        },
        { id: 'skill', name: '中文技能', path: '/skills/zh', enabled: true },
      ],
      skipped: [],
    });
    expect(JSON.parse(readFileSync(filePath, 'utf8')).skills).toHaveLength(2);
  });

  it('同名（不区分大小写）或同目录的技能跳过，批内也去重', async () => {
    const registry = createSkillRegistry({ filePath });
    await registry.add([{ name: 'pdf', path: '/skills/pdf' }]);
    const result = await registry.add([
      { name: 'PDF', path: '/other/pdf' },
      { name: 'renamed', path: '/skills/pdf' },
      { name: 'web', path: '/skills/web' },
      { name: 'WEB', path: '/skills/web2' },
    ]);
    expect(result.added.map((skill) => skill.id)).toEqual(['web']);
    expect(result.skipped).toHaveLength(3);
  });

  it('setEnabled / remove 按 id 操作，id 不存在时返回 undefined / false', async () => {
    const registry = createSkillRegistry({ filePath });
    await registry.add([{ name: 'pdf', path: '/skills/pdf' }]);
    expect(await registry.setEnabled('pdf', false)).toMatchObject({ id: 'pdf', enabled: false });
    expect(await registry.setEnabled('ghost', false)).toBeUndefined();
    expect(await registry.remove('ghost')).toBe(false);
    expect(await registry.remove('pdf')).toBe(true);
    expect(await registry.list()).toEqual([]);
  });
});

describe('parseStoredSkill', () => {
  it('宽松收窄：缺字段丢弃，enabled 缺省为 true', () => {
    expect(parseStoredSkill({ id: 'pdf', name: 'pdf', path: '/s/pdf', junk: 1 })).toEqual({
      id: 'pdf',
      name: 'pdf',
      path: '/s/pdf',
      enabled: true,
    });
    expect(parseStoredSkill({ id: 'pdf', name: 'pdf' })).toBeNull();
    expect(parseStoredSkill({ id: 'Bad', name: 'pdf', path: '/s' })).toBeNull();
  });
});
