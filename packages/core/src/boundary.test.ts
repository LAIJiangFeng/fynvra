import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
// `from '…'`、`import '…'`、`import('…')`、`require('…')`
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function librarySources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return librarySources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('package boundary', () => {
  it('库源码只做相对 import：不碰 electron、Node 内置模块或第三方运行时依赖', () => {
    const offenders = librarySources(SRC_DIR).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(SPECIFIER)]
        .map((match) => match[1] ?? '')
        .filter((specifier) => !specifier.startsWith('.'))
        .map((specifier) => `${relative(SRC_DIR, file)} → ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });
});
