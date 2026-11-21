import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../../../', import.meta.url));
// 匹配 bare 'fflate' 或 'fflate/node' 的导入
const BAD_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]fflate(?:\/node)?['"]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('Main / agent 的 fflate 导入', () => {
  it('只用 fflate/browser，node 版的 `var require` 会与 electron-vite 的 require shim 重名', () => {
    const offenders = ['main', 'agent']
      .flatMap((dir) => sources(join(SRC_DIR, dir)))
      .filter((file) => BAD_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });
});
