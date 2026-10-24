import { describe, expect, it } from 'vitest';
import { parseJsonc } from './jsonc';

describe('parseJsonc', () => {
  it('去掉字符串外的行注释、块注释与尾逗号；字符串里的 // 与 /* */ 原样保留', () => {
    const source = [
      '{',
      '  // VS Code 生成的说明',
      '  "servers": {',
      '    "web": { "type": "http", "url": "https://mcp.example.com/mcp", }, /* 远程 */',
      '    "local": {',
      '      "command": "node",',
      '      "args": ["C:/tools//server.js", "/* 不是注释 */", "a // b",],',
      '    },',
      '  },',
      '  /* 多行',
      '     块注释 */',
      '  "inputs": [],',
      '}',
    ].join('\n');
    expect(parseJsonc(source)).toEqual({
      ok: true,
      value: {
        servers: {
          web: { type: 'http', url: 'https://mcp.example.com/mcp' },
          local: { command: 'node', args: ['C:/tools//server.js', '/* 不是注释 */', 'a // b'] },
        },
        inputs: [],
      },
    });
  });

  it('转义的引号与反斜杠不会提前结束字符串；尾逗号后面隔着注释也能去掉', () => {
    const source = '{ "a": "say \\"hi\\" // here", "b": "C:\\\\x\\\\", "c": [1, 2, // 末项\n ], }';
    expect(parseJsonc(source)).toEqual({
      ok: true,
      value: { a: 'say "hi" // here', b: 'C:\\x\\', c: [1, 2] },
    });
  });

  it('普通 JSON 结果与 JSON.parse 相同', () => {
    const value = { mcpServers: { time: { command: 'uvx', args: ['mcp-server-time'] } }, n: 3 };
    expect(parseJsonc(JSON.stringify(value, null, 2))).toEqual({ ok: true, value });
  });

  it('出错时只给原文的行号（注释换成了空格，行号不变），不带任何原文', () => {
    const secret = 'ghp_secret_value_in_file';
    const source = ['{', '  // 注释', `  "token": "${secret}"`, '  "next": 1', '}'].join('\n');
    const result = parseJsonc(source);
    expect(result).toEqual({ ok: false, line: 4 });
    expect(JSON.stringify(result)).not.toContain(secret);

    const unexpected = parseJsonc(`{ "token": ${secret} }`);
    expect(unexpected).toEqual({ ok: false });
  });

  it('空白文本视为没有内容；全是 0 字节（写坏的文件）、未闭合的注释返回失败', () => {
    expect(parseJsonc('')).toEqual({ ok: true, value: undefined });
    expect(parseJsonc(' \r\n\t')).toEqual({ ok: true, value: undefined });
    expect(parseJsonc(String.fromCharCode(0).repeat(315))).toEqual({ ok: false });
    expect(parseJsonc('{ "a": 1 /* 没有闭合').ok).toBe(false);
    expect(parseJsonc('{ "a": "没有闭合的字符串\n}').ok).toBe(false);
  });
});
