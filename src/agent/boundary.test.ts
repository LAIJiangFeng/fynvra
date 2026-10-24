import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENT_DIR = fileURLToPath(new URL('.', import.meta.url));
// `from '…'`、`import '…'`、`import('…')`、`require('…')`
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const COMMENTS = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;

/**
 * worker 进程允许的依赖：agent-runtime、core、src/shared、Node 内置，
 * 以及 agent-runtime 不导出的 pi SDK 入口（ModelRuntime / SessionManager / 类型）。不允许 electron。
 */
const ALLOWED = [
  /^\./,
  /^node:/,
  /^@shared\//,
  /^@fynvra\/(agent-runtime|core)$/,
  /^@earendil-works\/pi-(ai|coding-agent)$/,
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('src/agent boundary', () => {
  it('worker 源码不 import electron，只用 agent-runtime / core / shared / Node 内置 / pi SDK', () => {
    const offenders = sources(AGENT_DIR).flatMap((file) =>
      [...readFileSync(file, 'utf8').replace(COMMENTS, '').matchAll(SPECIFIER)]
        .map((match) => match[1] ?? '')
        .filter((specifier) => !ALLOWED.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${relative(AGENT_DIR, file)} → ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });
});
