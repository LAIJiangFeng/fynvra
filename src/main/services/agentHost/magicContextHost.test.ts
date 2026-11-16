import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(join(tmpdir(), 'fynvra-magic-host-'));
vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: false, getAppPath: () => userData },
}));

const { magicContextHostConfig, prepareMagicContextHost, writeMagicContextConfig } = await import(
  './magicContextHost'
);

afterAll(() => rmSync(userData, { recursive: true, force: true }));

describe('Magic Context host config', () => {
  it('adds execute_threshold_tokens only when a threshold is set', () => {
    expect(magicContextHostConfig(200_000)).toMatchObject({
      execute_threshold_tokens: { default: 200_000 },
    });
    expect(magicContextHostConfig()).not.toHaveProperty('execute_threshold_tokens');
    expect(magicContextHostConfig(200_000)).toMatchObject(magicContextHostConfig());
  });

  it('rewrites the config file in place without leaving temp files', () => {
    const env = prepareMagicContextHost();
    const file = env.MAGIC_CONTEXT_CONFIG_FILE as string;
    const read = () => JSON.parse(readFileSync(file, 'utf8'));
    expect(read()).toEqual(magicContextHostConfig());
    writeMagicContextConfig(300_000);
    expect(read().execute_threshold_tokens).toEqual({ default: 300_000 });
    writeMagicContextConfig(undefined);
    expect(read()).not.toHaveProperty('execute_threshold_tokens');
    expect(readdirSync(join(file, '..'))).toEqual(['magic-context.jsonc']);
  });
});
