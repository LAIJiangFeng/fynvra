import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeText, readChatFile, sheetsToText } from './chatFiles';

const bytes = (...values: number[]) => new Uint8Array(values);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return out;
};
const utf16be = (s: string) => {
  const le = utf16le(s);
  for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
  return le;
};
// 「中文」的 GBK 编码
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];

describe('decodeText', () => {
  it('正常 UTF-8 原样解码', () => {
    expect(decodeText(utf8('# 标题\nok'))).toBe('# 标题\nok');
  });

  it('去掉开头的 BOM', () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('a');
  });

  it('GBK 字节按 GB18030 解码', () => {
    expect(decodeText(bytes(...GBK_ZHONGWEN))).toBe('中文');
  });

  it('带 BOM 的 UTF-16LE / BE 与不带 BOM 的 UTF-16LE', () => {
    const s = 'boot ok 上电就绪\r\nready';
    expect(decodeText(concat(bytes(0xff, 0xfe), utf16le(s)))).toBe(s);
    expect(decodeText(concat(bytes(0xfe, 0xff), utf16be(s)))).toBe(s);
    expect(decodeText(utf16le(s))).toBe(s);
  });

  it('含少量 NUL 的 UTF-8 日志通过并去掉 NUL', () => {
    const log = concat(bytes(0, 0), utf8('[0.001] 上电初始化完成\nsystem ready\n'), bytes(0));
    expect(decodeText(log)).toBe('[0.001] 上电初始化完成\nsystem ready\n');
  });

  it('开头有乱码字节的 UTF-8 中文日志按 UTF-8 解码', () => {
    const text = decodeText(
      concat(bytes(0xff, 0xfe, 0xff, 0xfe), utf8('系统上电，版本 r6477 就绪\n电压正常\n'.repeat(3)))
    );
    expect(text).toContain('系统上电，版本 r6477 就绪\n电压正常');
  });

  it('开头有 0xFF 的 GBK 中文日志按 GB18030 解码', () => {
    const text = decodeText(
      concat(bytes(0xff), bytes(...GBK_ZHONGWEN), utf8(' log\n'), bytes(...GBK_ZHONGWEN))
    );
    expect(text).toBe('\uFFFD中文 log\n中文');
  });

  it('二进制返回 null', () => {
    const cycle = Array.from({ length: 512 }, (_, i) => i % 256);
    expect(decodeText(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...cycle))).toBeNull();
    expect(decodeText(bytes(0, 1, 2))).toBeNull();
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

  it('大写扩展名的 GBK 文本可以读', async () => {
    expect(await readChatFile(new File([bytes(...GBK_ZHONGWEN)], '日志.TXT'))).toEqual({
      ok: true,
      file: { name: '日志.TXT', text: '中文' },
    });
  });

  it('xlsx 按工作表转 TSV', async () => {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const sheetXml = (rows: string) =>
      `<?xml version="1.0"?><worksheet ${ns}><sheetData>${rows}</sheetData></worksheet>`;
    // 默认压缩打包，和真实 xlsx 一样是 deflate 条目
    const xlsx = zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
          '</Types>'
      ),
      '_rels/.rels': strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
      ),
      'xl/workbook.xml': strToU8(
        `<?xml version="1.0"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="汇总" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets></workbook>`
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/>` +
          `<Relationship Id="rId3" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/>` +
          '</Relationships>'
      ),
      'xl/sharedStrings.xml': strToU8(
        `<?xml version="1.0"?><sst ${ns} count="3" uniqueCount="3"><si><t>名称</t></si><si><t>数量</t></si><si><t>苹果</t></si></sst>`
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        sheetXml(
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row>'
        )
      ),
      'xl/worksheets/sheet2.xml': strToU8(sheetXml('<row r="1"><c r="A1"><v>42</v></c></row>')),
    });
    expect(await readChatFile(new File([xlsx], 'a.xlsx'))).toEqual({
      ok: true,
      file: {
        name: 'a.xlsx',
        text: '## Sheet: 汇总\n名称\t数量\n苹果\t12.5\n\n## Sheet: 明细\n42',
      },
    });
  });

  it('损坏的 xlsx 是 unreadable，旧版 xls 是 unsupported', async () => {
    expect(
      await readChatFile(new File([bytes(0x50, 0x4b, 0x03, 0x04, 1, 2, 3)], 'a.xlsx'))
    ).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(
      await readChatFile(new File([bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)], 'a.xls'))
    ).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('超过内联字数上限的文本照常读出（由 store 存副本）', async () => {
    const text = 'a'.repeat(200_001);
    expect(await readChatFile(new File([text], 'big.log'))).toEqual({
      ok: true,
      file: { name: 'big.log', text },
    });
  });
});

describe('sheetsToText', () => {
  it('多个工作表、空单元格、空行与空表', () => {
    expect(
      sheetsToText([
        { sheet: 'A', data: [['x', null, 'y', null, null], [null, null], ['z']] },
        { sheet: '空', data: [[null], []] },
        { sheet: 'B', data: [[1, true, false, 0.5]] },
      ])
    ).toBe('## Sheet: A\nx\t\ty\nz\n\n## Sheet: B\n1\ttrue\tfalse\t0.5');
  });

  it('单元格里的制表符和换行换成空格', () => {
    expect(sheetsToText([{ sheet: 'S', data: [['a\tb', 'c\r\nd']] }])).toBe(
      '## Sheet: S\na b\tc  d'
    );
  });

  it('日期：只有日期时去掉时间部分', () => {
    expect(
      sheetsToText([
        {
          sheet: 'D',
          data: [[new Date('2024-03-05T00:00:00.000Z'), new Date('2024-03-05T08:30:00.000Z')]],
        },
      ])
    ).toBe('## Sheet: D\n2024-03-05\t2024-03-05T08:30:00.000Z');
  });

  it('全部为空得到空串', () => {
    expect(sheetsToText([{ sheet: 'E', data: [[null, '']] }])).toBe('');
  });
});
