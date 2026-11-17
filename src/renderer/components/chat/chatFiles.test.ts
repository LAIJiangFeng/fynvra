import { describe, expect, it } from 'vitest';
import { decodeUtf8Text, readChatFile } from './chatFiles';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('decodeUtf8Text', () => {
  it('正常 UTF-8 原样解码', () => {
    expect(decodeUtf8Text(new TextEncoder().encode('# 标题\nok'))).toBe('# 标题\nok');
  });

  it('去掉开头的 BOM', () => {
    expect(decodeUtf8Text(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('a');
  });

  it('含 NUL 的当作二进制', () => {
    expect(decodeUtf8Text(bytes(0x61, 0x00, 0x62))).toBeNull();
  });

  it('非法 UTF-8（GBK 字节）不支持', () => {
    // 「中文」的 GBK 编码
    expect(decodeUtf8Text(bytes(0xd6, 0xd0, 0xce, 0xc4))).toBeNull();
  });
});

describe('readChatFile', () => {
  it('文本文件读出内容', async () => {
    expect(await readChatFile(new File(['a,b\n1,2'], 'x.csv'))).toEqual({
      ok: true,
      file: { name: 'x.csv', text: 'a,b\n1,2' },
    });
  });

  it('空白文本是 empty，二进制是 unsupported', async () => {
    expect(await readChatFile(new File([' \n'], 'a.txt'))).toEqual({ ok: false, reason: 'empty' });
    expect(await readChatFile(new File([bytes(0, 1, 2)], 'a.bin'))).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('超过字数上限是 size', async () => {
    expect(await readChatFile(new File(['a'.repeat(200_001)], 'big.log'))).toEqual({
      ok: false,
      reason: 'size',
    });
  });
});
