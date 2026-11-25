import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { MAX_CHAT_FILE_BYTES } from '@shared/types/chat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileName,
  countByteLines,
  createSessionAttachments,
  isValidAttachmentName,
} from './attachments';

const encode = (text: string) => new TextEncoder().encode(text);

describe('isValidAttachmentName', () => {
  it('只接受不含路径与控制字符、长度有限的显示名', () => {
    expect(isValidAttachmentName('serial log 2024.txt')).toBe(true);
    expect(isValidAttachmentName('日志.log')).toBe(true);
    for (const bad of ['', ' ', '.', '..', 'a/b.txt', 'a\\b.txt', 'a\nb', 'x'.repeat(256), 1]) {
      expect(isValidAttachmentName(bad)).toBe(false);
    }
  });
});

describe('copyFileName', () => {
  it('只留安全字符并保留扩展名；抽取格式与无扩展名的加 .txt', () => {
    expect(copyFileName('serial log.log', 'ab12')).toBe('ab12-serial_log.log');
    expect(copyFileName('报告.pdf', 'ab12')).toBe('ab12-pdf.txt');
    expect(copyFileName('表.xlsx', 'ab12')).toBe('ab12-xlsx.txt');
    expect(copyFileName('..\u202e.txt', 'ab12')).toBe('ab12-txt.txt');
    expect(copyFileName('Makefile', 'ab12')).toBe('ab12-Makefile.txt');
    expect(copyFileName('...', 'ab12')).toBe('ab12-attachment.txt');
    const long = copyFileName(`${'a'.repeat(200)}.log`, 'ab12');
    expect(long.endsWith('.log')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(5 + 80);
  });
});

describe('countByteLines', () => {
  it('按换行计，末尾没有换行的一段也算一行', () => {
    expect(countByteLines(encode(''))).toBe(0);
    expect(countByteLines(encode('a'))).toBe(1);
    expect(countByteLines(encode('a\n'))).toBe(1);
    expect(countByteLines(encode('a\nb'))).toBe(2);
  });
});

describe('createSessionAttachments', () => {
  let root: string;
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'fynvra-copies-')), 'session-attachments');
  });
  afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

  it('副本写在会话目录里，返回路径、字节数与行数', async () => {
    const attachments = createSessionAttachments({ root, newPrefix: () => '0001' });
    const copy = await attachments.save('s-1', 'serial.log', encode('boot\nready\n'));
    expect(copy).toEqual({
      path: join(root, 's-1', '0001-serial.log'),
      bytes: 11,
      lines: 2,
    });
    expect(readFileSync(copy.path, 'utf8')).toBe('boot\nready\n');
    expect(attachments.dirOf('s-1')).toBe(join(root, 's-1'));
  });

  it('文件名由 Main 生成：显示名里的路径写法不会越界', async () => {
    const attachments = createSessionAttachments({ root, newPrefix: () => '0002' });
    const copy = await attachments.save('s-1', '..%2f..%2fevil.txt', encode('x'));
    const rel = relative(join(root, 's-1'), copy.path);
    expect(rel.startsWith('..')).toBe(false);
    expect(dirname(copy.path)).toBe(join(root, 's-1'));
  });

  it('拒绝非法会话 id、非法显示名、空内容与超过 32 MiB 的内容', async () => {
    const attachments = createSessionAttachments({ root });
    await expect(attachments.save('../s-1', 'a.txt', encode('x'))).rejects.toThrow();
    await expect(attachments.save('s-1', '../a.txt', encode('x'))).rejects.toThrow();
    await expect(attachments.save('s-1', 'a.txt', new Uint8Array())).rejects.toThrow();
    await expect(
      attachments.save('s-1', 'a.txt', new Uint8Array(MAX_CHAT_FILE_BYTES + 1))
    ).rejects.toThrow();
    expect(() => attachments.dirOf('a/b')).toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it('remove 删掉会话的副本目录，不存在也不报错', async () => {
    const attachments = createSessionAttachments({ root });
    const copy = await attachments.save('s-1', 'a.txt', encode('x'));
    await attachments.save('s-2', 'b.txt', encode('y'));
    await attachments.remove('s-1');
    expect(existsSync(copy.path)).toBe(false);
    expect(existsSync(join(root, 's-1'))).toBe(false);
    expect(existsSync(join(root, 's-2'))).toBe(true);
    await expect(attachments.remove('s-1')).resolves.toBeUndefined();
  });
});
