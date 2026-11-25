import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 0, 10);
  /** 写一份副本并把修改时间设到 now - ageMs */
  const copyAt = (name: string, ageMs: number, bytes = 1) => {
    const path = join(root, 's-1', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'x'.repeat(bytes));
    const time = (now - ageMs) / 1000;
    utimesSync(path, time, time);
    return path;
  };

  it('prune 删掉超过 7 天的副本，新的留下；删空了连目录一起删', async () => {
    const attachments = createSessionAttachments({ root });
    const old = copyAt('old.txt', 8 * DAY);
    const fresh = copyAt('fresh.txt', 6 * DAY);
    await attachments.prune('s-1', { now });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await attachments.prune('s-1', { now: now + 2 * DAY });
    expect(existsSync(join(root, 's-1'))).toBe(false);
  });

  it('prune 在总大小超限时从最旧的删起', async () => {
    const attachments = createSessionAttachments({ root });
    const a = copyAt('a.txt', 3000, 10);
    const b = copyAt('b.txt', 2000, 10);
    const c = copyAt('c.txt', 1000, 10);
    await attachments.prune('s-1', { now, maxBytes: 15 });
    expect([a, b, c].map((path) => existsSync(path))).toEqual([false, false, true]);
  });

  it('prune 不进子目录', async () => {
    const attachments = createSessionAttachments({ root });
    const nested = copyAt(join('sub', 'old.txt'), 30 * DAY);
    await attachments.prune('s-1', { now, maxBytes: 0 });
    expect(existsSync(nested)).toBe(true);
  });

  it('prune 不跟随也不删符号链接', async (context) => {
    const attachments = createSessionAttachments({ root });
    const outside = join(dirname(root), 'outside.txt');
    writeFileSync(outside, 'keep');
    const time = (now - 30 * DAY) / 1000;
    utimesSync(outside, time, time);
    mkdirSync(join(root, 's-1'), { recursive: true });
    const link = join(root, 's-1', 'link.txt');
    try {
      symlinkSync(outside, link, 'file');
    } catch {
      // 没有创建符号链接的权限（Windows 非开发者模式）
      context.skip();
    }
    await attachments.prune('s-1', { now, maxBytes: 0 });
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('prune 目录不存在或会话 id 非法时不抛异常', async () => {
    const attachments = createSessionAttachments({ root });
    await expect(attachments.prune('s-404')).resolves.toBeUndefined();
    await expect(attachments.prune('../s-1')).resolves.toBeUndefined();
  });
});
