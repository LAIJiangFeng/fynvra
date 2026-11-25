import { describe, expect, it, vi } from 'vitest';
import {
  type ChatFileExtractors,
  ChatFileTooLargeError,
  chatFileCopyNote,
  extractChatFileText,
  MAX_CHAT_FILE_TEXT_CHARS,
} from './chatFileText';
import { MAX_CHAT_FILE_BYTES, MAX_CHAT_FILES_TOTAL_CHARS } from './types/chat';

const none: ChatFileExtractors = {
  pdf: vi.fn(async () => 'pdf'),
  docx: vi.fn(async () => 'docx'),
  xlsx: vi.fn(async () => 'xlsx'),
};

describe('extractChatFileText', () => {
  it('GBK 文本', async () => {
    const result = await extractChatFileText(
      'a.txt',
      new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]),
      none
    );
    expect(result).toEqual({ ok: true, file: { name: 'a.txt', text: '中文' } });
  });

  it('UTF-16 LE 带 BOM', async () => {
    const result = await extractChatFileText(
      'a.log',
      new Uint8Array([0xff, 0xfe, 0x41, 0, 0x2d, 0x4e]),
      none
    );
    expect(result).toEqual({ ok: true, file: { name: 'a.log', text: 'A中' } });
  });

  it('二进制拒绝为 unsupported', async () => {
    const result = await extractChatFileText(
      'a.bin',
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      none
    );
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('空白文本为 empty', async () => {
    expect(await extractChatFileText('a.txt', new TextEncoder().encode(' \n '), none)).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('超过内联上限的文本照常抽出（由调用方存副本），超过字节上限或文字上限为 size', async () => {
    const long = new TextEncoder().encode('a'.repeat(MAX_CHAT_FILES_TOTAL_CHARS + 1));
    const result = await extractChatFileText('a.txt', long, none);
    expect(result.ok && result.file.text.length).toBe(MAX_CHAT_FILES_TOTAL_CHARS + 1);
    const huge = new Uint8Array(MAX_CHAT_FILE_BYTES + 1);
    expect(await extractChatFileText('a.txt', huge, none)).toEqual({ ok: false, reason: 'size' });
    const extracted: ChatFileExtractors = {
      ...none,
      pdf: async () => 'p'.repeat(MAX_CHAT_FILE_TEXT_CHARS + 1),
    };
    const pdf = new TextEncoder().encode('%PDF-1.4');
    expect(await extractChatFileText('a.pdf', pdf, extracted)).toEqual({
      ok: false,
      reason: 'size',
    });
  });

  it('超限文档的说明块只带文件名、大小、行数与副本路径', () => {
    const note = chatFileCopyNote('serial.log', {
      path: '/data/session-attachments/s-1/ab12-serial.log',
      bytes: 2_097_152,
      lines: 40_000,
    });
    expect(note.name).toBe('serial.log');
    expect(note.text).toContain('path: /data/session-attachments/s-1/ab12-serial.log');
    expect(note.text).toContain('size: 2097152 bytes, 40000 lines');
    expect(note.text).toContain('read tool');
  });

  it('按扩展名与魔数分派到抽取器，抽取器异常分别记为 size / unreadable', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4');
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    expect(await extractChatFileText('a.PDF', pdf, none)).toMatchObject({
      ok: true,
      file: { text: 'pdf' },
    });
    expect(await extractChatFileText('a.docx', zip, none)).toMatchObject({
      file: { text: 'docx' },
    });
    const failing: ChatFileExtractors = {
      ...none,
      xlsx: async () => {
        throw new ChatFileTooLargeError();
      },
      docx: async () => {
        throw new Error('bad');
      },
    };
    expect(await extractChatFileText('a.xlsx', zip, failing)).toEqual({
      ok: false,
      reason: 'size',
    });
    expect(await extractChatFileText('a.docx', zip, failing)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('内容恰好是 size 字样的文本不被误判', async () => {
    expect(
      await extractChatFileText('a.txt', new TextEncoder().encode('size'), none)
    ).toMatchObject({
      ok: true,
    });
  });
});
