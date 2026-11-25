import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CHAT_FILES_TOTAL_CHARS, MAX_CHAT_IMAGES } from '@shared/types/chat';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAttachments, sniffImage } from './attachments';
import { MAIN_EXTRACTORS } from './extractors';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** 手写一个最小 PDF：一页，Helvetica 写一行字；xref 偏移按实际字节算 */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function minimalDocx(text: string): Uint8Array {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>'
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    ),
  });
}

function minimalXlsx(): Uint8Array {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>'
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0"?><worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1"><v>7</v></c></row></sheetData></worksheet>`
    ),
  });
}

describe('Main 端抽取器（Node 环境真实解析）', () => {
  it('PDF 抽出文字', async () => {
    expect((await MAIN_EXTRACTORS.pdf(minimalPdf('Hello PDF'))).trim()).toBe('Hello PDF');
  });

  it('docx 抽出文字', async () => {
    expect((await MAIN_EXTRACTORS.docx(minimalDocx('你好 docx'))).trim()).toBe('你好 docx');
  });

  it('xlsx 转成 TSV', async () => {
    expect(await MAIN_EXTRACTORS.xlsx(minimalXlsx())).toBe('## Sheet: S\n名称\t7');
  });
});

describe('sniffImage', () => {
  it('按魔数识别，不看扩展名', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(strToU8('GIF89a...'))).toBe('image/gif');
    expect(sniffImage(strToU8('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(strToU8('hello.png'))).toBeNull();
  });
});

describe('loadAttachments', () => {
  let dataDir: string;
  let dir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'fynvra-attach-'));
    dir = join(dataDir, 'attachments');
    mkdirSync(dir);
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('图片进 images，文档抽成 ChatFile，不支持的进 rejected', async () => {
    writeFileSync(join(dir, 'p.bin'), PNG);
    writeFileSync(join(dir, 'a.txt'), '日志内容');
    writeFileSync(join(dir, 'b.pdf'), minimalPdf('Report'));
    writeFileSync(join(dir, 'c.bin'), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const loaded = await loadAttachments(
      dataDir,
      [
        { file: 'p.bin', name: 'photo.jpg' },
        { file: 'a.txt', name: 'a.txt' },
        { file: 'b.pdf', name: 'b.pdf' },
        { file: 'c.bin', name: 'c.exe' },
      ],
      MAIN_EXTRACTORS
    );
    expect(loaded.images).toEqual([
      { data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png' },
    ]);
    expect(loaded.files.map((f) => [f.name, f.text.trim()])).toEqual([
      ['a.txt', '日志内容'],
      ['b.pdf', 'Report'],
    ]);
    expect(loaded.rejected).toEqual([{ name: 'c.exe', reason: 'unsupported' }]);
  });

  it('不存在、目录、符号链接一律 unreadable', async () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dataDir, 'secret.txt'), 'secret');
    let linked = true;
    try {
      symlinkSync(join(dataDir, 'secret.txt'), join(dir, 'link.txt'));
    } catch {
      linked = false; // Windows 无创建符号链接的权限时跳过这一项
    }
    const items = [
      { file: 'missing.txt', name: 'm' },
      { file: 'sub', name: 'd' },
      ...(linked ? [{ file: 'link.txt', name: 'l' }] : []),
    ];
    const loaded = await loadAttachments(dataDir, items);
    expect(loaded.files).toEqual([]);
    expect(loaded.rejected).toEqual(items.map((i) => ({ name: i.name, reason: 'unreadable' })));
  });

  it('attachments 目录本身指向别处时越界被拒', async () => {
    rmSync(dir, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'fynvra-outside-'));
    try {
      writeFileSync(join(outside, 'a.txt'), 'secret');
      symlinkSync(outside, dir, 'junction');
      const loaded = await loadAttachments(dataDir, [{ file: 'a.txt', name: 'a.txt' }]);
      expect(loaded.rejected).toEqual([{ name: 'a.txt', reason: 'unreadable' }]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('图片张数与文字合计超过输入框上限的进 rejected（size）', async () => {
    writeFileSync(join(dir, 'p.png'), PNG);
    const images = Array.from({ length: MAX_CHAT_IMAGES + 1 }, (_, i) => ({
      file: 'p.png',
      name: `p${i}`,
    }));
    const many = await loadAttachments(dataDir, images);
    expect(many.images).toHaveLength(MAX_CHAT_IMAGES);
    expect(many.rejected).toEqual([{ name: `p${MAX_CHAT_IMAGES}`, reason: 'size' }]);

    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(MAX_CHAT_FILES_TOTAL_CHARS - 10));
    writeFileSync(join(dir, 'small.txt'), 'b'.repeat(20));
    const text = await loadAttachments(
      dataDir,
      [
        { file: 'big.txt', name: 'big.txt' },
        { file: 'small.txt', name: 'small.txt' },
      ],
      MAIN_EXTRACTORS
    );
    expect(text.files.map((f) => f.name)).toEqual(['big.txt']);
    expect(text.rejected).toEqual([{ name: 'small.txt', reason: 'size' }]);
  });

  it('有 saveCopy 时合计超限的文档存副本、只放路径说明，不再拒绝', async () => {
    const log = 'line\n'.repeat(60_000);
    writeFileSync(join(dir, 'serial.log'), log);
    writeFileSync(join(dir, 'small.txt'), 'b'.repeat(20));
    const saved: Array<{ name: string; content: Uint8Array }> = [];
    const loaded = await loadAttachments(
      dataDir,
      [
        { file: 'serial.log', name: 'serial.log' },
        { file: 'small.txt', name: 'small.txt' },
      ],
      MAIN_EXTRACTORS,
      undefined,
      async (name, content) => {
        saved.push({ name, content });
        return { path: '/copies/s-1/0000-serial.log', bytes: content.length, lines: 60_000 };
      }
    );
    expect(loaded.rejected).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(new TextDecoder().decode(saved[0]?.content)).toBe(log);
    expect(loaded.files.map((f) => f.name)).toEqual(['serial.log', 'small.txt']);
    expect(loaded.files[0]?.text).toContain('path: /copies/s-1/0000-serial.log');
    expect(loaded.files[0]?.text).toContain('60000 lines');
    expect(loaded.files[0]?.text.length).toBeLessThan(1_000);
  });

  it('副本保存失败时仍记为 size', async () => {
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(MAX_CHAT_FILES_TOTAL_CHARS + 1));
    const loaded = await loadAttachments(
      dataDir,
      [{ file: 'big.txt', name: 'big.txt' }],
      MAIN_EXTRACTORS,
      undefined,
      async () => {
        throw new Error('disk full');
      }
    );
    expect(loaded.files).toEqual([]);
    expect(loaded.rejected).toEqual([{ name: 'big.txt', reason: 'size' }]);
  });

  it('单张图片超过 20 MB 进 rejected', async () => {
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set(PNG);
    writeFileSync(join(dir, 'big.png'), big);
    const loaded = await loadAttachments(dataDir, [{ file: 'big.png', name: 'big.png' }]);
    expect(loaded.images).toEqual([]);
    expect(loaded.rejected).toEqual([{ name: 'big.png', reason: 'size' }]);
  });
});
