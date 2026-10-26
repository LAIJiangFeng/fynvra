import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, readSkillManifest } from './skillManifest';

const BOM = String.fromCharCode(0xfeff);

describe('parseSkillFrontmatter', () => {
  it('折叠块 >- 拼成一行，后面的字段照常读取', () => {
    const text = [
      '---',
      'name: computer-use',
      'description: >-',
      '  Drives a visible local app window through desktop controls: accessibility',
      '  tree, clicks, typing, menus.',
      '',
      '  Use only when needed.',
      'version: 1.0.0',
      '---',
      '',
      '# Computer Use',
    ].join('\n');
    expect(parseSkillFrontmatter(text)).toEqual({
      name: 'computer-use',
      description:
        'Drives a visible local app window through desktop controls: accessibility tree, clicks, typing, menus.\nUse only when needed.',
    });
  });

  it('双引号字符串（含转义）与嵌套 metadata 映射', () => {
    const text = [
      '---',
      'name: lark-im',
      'version: 1.0.0',
      'description: "飞书即时通讯：收发消息和管理群聊。卡片按钮回调（card.action.trigger）\\"引号\\""',
      'metadata:',
      '  requires:',
      '    bins: ["lark-cli"]',
      '  cliHelp: "lark-cli im --help"',
      '---',
    ].join('\n');
    expect(parseSkillFrontmatter(text)).toEqual({
      name: 'lark-im',
      description: '飞书即时通讯：收发消息和管理群聊。卡片按钮回调（card.action.trigger）"引号"',
    });
  });

  it("普通标量可以跨行、可以带行尾注释；单引号里 '' 表示一个引号", () => {
    const text = [
      '---',
      "name: 'it''s-a-skill'",
      'description: Interview the user relentlessly about a plan, or mentions "grill me". # note',
      '  Continued on the next line.',
      '---',
    ].join('\r\n');
    expect(parseSkillFrontmatter(`${BOM}${text}`)).toEqual({
      name: "it's-a-skill",
      description:
        'Interview the user relentlessly about a plan, or mentions "grill me". Continued on the next line.',
    });
  });

  it('字面块 | 保留换行', () => {
    const text = ['---', 'name: x', 'description: |', '  line one', '  line two', '---'].join('\n');
    expect(parseSkillFrontmatter(text).description).toBe('line one\nline two');
  });

  it('没有 frontmatter、未闭合或字段为空时返回空字段', () => {
    expect(parseSkillFrontmatter('# Title\n\nbody')).toEqual({});
    expect(parseSkillFrontmatter('---\nname: x\n')).toEqual({});
    expect(parseSkillFrontmatter('---\nname:\ndescription: "  "\n---\n')).toEqual({});
  });
});

describe('readSkillManifest', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fynvra-skill-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('读 <dir>/SKILL.md；没有 name 时用目录名，描述截到 1024 字符', async () => {
    const skillDir = join(dir, 'pdf-tools');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), `---\ndescription: ${'d'.repeat(2000)}\n---\n`);
    const result = await readSkillManifest(skillDir);
    expect(result).toMatchObject({ ok: true, manifest: { name: 'pdf-tools' } });
    expect(result.ok && result.manifest.description).toHaveLength(1024);
  });

  it('目录里没有 SKILL.md、或者根本不是目录时返回错误', async () => {
    expect(await readSkillManifest(dir)).toMatchObject({ ok: false });
    writeFileSync(join(dir, 'file.txt'), 'x');
    expect(await readSkillManifest(join(dir, 'file.txt'))).toMatchObject({ ok: false });
  });
});
