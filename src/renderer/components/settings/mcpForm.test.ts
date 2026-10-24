import type { McpServerEntryView } from '@shared/types/llm';
import { describe, expect, it } from 'vitest';
import { addSecretRow, draftFromServer, draftToMcpInput, emptyMcpDraft } from './mcpForm';

const github: McpServerEntryView = {
  id: 'github',
  name: 'GitHub',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  enabled: true,
  envKeys: ['GITHUB_TOKEN'],
  headerKeys: [],
};

describe('mcpForm', () => {
  it('新建 stdio：参数一行一个，空行忽略；env 新行必须有值', () => {
    const draft = {
      ...emptyMcpDraft(),
      name: 'Time',
      command: ' uvx ',
      argsText: 'mcp-server-time\n\n  --local-timezone=Asia/Shanghai  \r\n',
      env: addSecretRow([], 'TZ', 'Asia/Shanghai'),
    };
    expect(draftToMcpInput(draft)).toEqual({
      ok: true,
      input: {
        name: 'Time',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-time', '--local-timezone=Asia/Shanghai'],
        enabled: true,
        env: [{ key: 'TZ', value: 'Asia/Shanghai' }],
      },
    });
    expect(draftToMcpInput({ ...draft, env: addSecretRow([], 'TZ', '') })).toMatchObject({
      ok: false,
    });
  });

  it('编辑：已保存的键不填值表示沿用（只提交 key），新填的值覆盖', () => {
    const draft = draftFromServer(github);
    expect(draft).toMatchObject({
      id: 'github',
      command: 'npx',
      argsText: '-y\n@modelcontextprotocol/server-github',
    });
    expect(draft.env).toMatchObject([{ key: 'GITHUB_TOKEN', value: '', saved: true }]);
    expect(draftToMcpInput(draft)).toMatchObject({
      ok: true,
      input: { id: 'github', env: [{ key: 'GITHUB_TOKEN' }] },
    });

    const [row] = draft.env;
    if (!row) throw new Error('missing row');
    const rotated = { ...draft, env: [{ ...row, value: 'ghp_new' }] };
    expect(draftToMcpInput(rotated)).toMatchObject({
      input: { env: [{ key: 'GITHUB_TOKEN', value: 'ghp_new' }] },
    });
    expect(draftToMcpInput({ ...draft, env: [] })).toMatchObject({ ok: true, input: { env: [] } });
  });

  it('远程：URL 必填，只提交 headers；全空的行忽略', () => {
    const draft = {
      ...emptyMcpDraft(),
      name: 'Docs',
      transport: 'http' as const,
      url: ' https://mcp.example.com/mcp ',
      headers: addSecretRow(addSecretRow([], 'Authorization', 'Bearer x'), '', ''),
    };
    expect(draftToMcpInput(draft)).toEqual({
      ok: true,
      input: {
        name: 'Docs',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        enabled: true,
        headers: [{ key: 'Authorization', value: 'Bearer x' }],
      },
    });
    expect(draftToMcpInput({ ...draft, url: '' })).toMatchObject({ ok: false });
  });

  it('校验：名称、命令必填；键名不能重复或含空白', () => {
    const base = { ...emptyMcpDraft(), name: 'X', command: 'npx' };
    expect(draftToMcpInput({ ...base, name: '' })).toMatchObject({ ok: false });
    expect(draftToMcpInput({ ...base, command: ' ' })).toMatchObject({ ok: false });
    expect(
      draftToMcpInput({ ...base, env: addSecretRow(addSecretRow([], 'A', '1'), 'A', '2') })
    ).toMatchObject({ ok: false });
    expect(draftToMcpInput({ ...base, env: addSecretRow([], 'A B', '1') })).toMatchObject({
      ok: false,
    });
  });
});
