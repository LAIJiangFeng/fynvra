import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../../../electron.vite.config';

const SRC_DIR = fileURLToPath(new URL('../../../', import.meta.url));
// 匹配 bare 'fflate' 或 'fflate/node' 的导入
const BAD_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]fflate(?:\/node)?['"]/;
// 未压缩的 pdf.js legacy 构建里有局部 `const require`，Main 只能用 .min 版
const BAD_PDFJS = /['"]pdfjs-dist\/legacy\/build\/pdf(?:\.worker)?\.mjs['"]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const offenders = (pattern: RegExp) =>
  ['main', 'agent']
    .flatMap((dir) => sources(join(SRC_DIR, dir)))
    .filter((file) => !file.endsWith('.d.ts') && pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC_DIR, file));

describe('Main / agent 的 fflate 导入', () => {
  it('只用 fflate/browser，node 版的 `var require` 会与 electron-vite 的 require shim 重名', () => {
    expect(offenders(BAD_IMPORT)).toEqual([]);
  });

  it('依赖里的裸 fflate（如 read-excel-file/universal）在 Main 构建中被改到 fflate/browser', () => {
    const main = typeof config === 'function' ? undefined : config.main;
    const alias = main?.resolve?.alias;
    const entries = Array.isArray(alias) ? alias : [];
    const fflate = entries.find(
      (entry) => entry.find instanceof RegExp && entry.find.test('fflate')
    );
    expect(fflate?.replacement).toBe('fflate/browser');
    expect(entries.some((e) => e.find instanceof RegExp && e.find.test('fflate/browser'))).toBe(
      false
    );
  });

  it('pdf.js 只用 legacy 的 .min 构建', () => {
    expect(offenders(BAD_PDFJS)).toEqual([]);
  });
});
