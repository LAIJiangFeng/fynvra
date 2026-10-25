import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { planRelease, selectMacSigningMode, verifyRelease } from '../../../../scripts/release';

const sha = 'a'.repeat(40);
const old = 'b'.repeat(40);

describe('Mac 签名模式', () => {
  const credentials = {
    MAC_CSC_LINK: '测试证书',
    MAC_CSC_KEY_PASSWORD: '测试密码',
    APPLE_ID: 'test@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: '测试专用密码',
    APPLE_TEAM_ID: '测试团队',
  };
  it('没有凭证也能打包，完整凭证才启用正式签名公证', () => {
    expect(selectMacSigningMode({})).toBe('manual');
    expect(selectMacSigningMode({ MAC_CSC_LINK: '  ' })).toBe('manual');
    expect(selectMacSigningMode(credentials)).toBe('signed');
  });
  it('不将部分缺失的正式签名配置静默降级为手动包，也不泄露凭证值', () => {
    for (const key of Object.keys(credentials)) {
      expect(() => selectMacSigningMode({ ...credentials, [key]: '' })).toThrow(key);
    }
    expect(() => selectMacSigningMode({ MAC_CSC_LINK: '不应出现在日志的证书值' })).toThrow(
      'MAC_CSC_KEY_PASSWORD'
    );
    expect(() => selectMacSigningMode({ MAC_CSC_LINK: '不应出现在日志的证书值' })).not.toThrow(
      '不应出现在日志的证书值'
    );
  });
});

describe('自动发布版本规划', () => {
  it('首发高于当前客户端版本，后续按最高稳定标签递增补丁版本', () => {
    expect(planRelease('0.1.0', [], sha)).toEqual({ version: '0.1.1', tag: 'v0.1.1' });
    expect(
      planRelease(
        '0.1.0',
        [
          { name: 'v0.1.9', sha: old },
          { name: 'v0.1.10', sha: old },
          { name: 'v2.0.0-beta.1', sha: old },
          { name: 'misc', sha: old },
        ],
        sha
      )
    ).toEqual({ version: '0.1.11', tag: 'v0.1.11' });
  });
  it('显式提高主版本或次版本时使用该版本，重复运行相同提交复用标签', () => {
    expect(planRelease('0.2.0', [{ name: 'v0.1.5', sha: old }], sha).version).toBe('0.2.0');
    expect(planRelease('0.1.0', [{ name: 'v0.1.5', sha }], sha).version).toBe('0.1.5');
  });
  it('不把旧发布重新置为 latest，拒绝非法版本和提交 id', () => {
    expect(() =>
      planRelease(
        '0.1.0',
        [
          { name: 'v0.1.4', sha },
          { name: 'v0.1.5', sha: old },
        ],
        sha
      )
    ).toThrow();
    for (const version of ['1.2', '1.2.3-beta.1', '01.2.3', '1.2.3\ncommand']) {
      expect(() => planRelease(version, [], sha)).toThrow();
    }
    expect(() => planRelease('0.1.0', [], 'main; command')).toThrow();
  });
});

describe('发布产物校验', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-release-'));
    dirs.push(dir);
    const name = 'Fynvra-0.1.1-x64-setup.exe';
    const bytes = Buffer.from('测试安装包');
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    const metadata = {
      version: '0.1.1',
      path: name,
      sha512,
      files: [{ url: name, sha512, size: bytes.length }],
    };
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, `${name}.blockmap`), '测试差分元数据');
    writeFileSync(join(dir, 'latest.yml'), stringify(metadata));
    return { dir, name, metadata };
  }
  function macFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-mac-release-'));
    dirs.push(dir);
    const files = ['x64', 'arm64'].flatMap((arch) =>
      ['zip', 'dmg'].map((extension) => {
        const url = `Fynvra-0.1.1-mac-${arch}.${extension}`;
        const bytes = Buffer.from(`测试 ${arch} ${extension}`);
        const sha512 = createHash('sha512').update(bytes).digest('base64');
        writeFileSync(join(dir, url), bytes);
        if (extension === 'zip') writeFileSync(join(dir, `${url}.blockmap`), '差分元数据');
        return { url, sha512, size: bytes.length };
      })
    );
    const metadata = { version: '0.1.1', path: files[0].url, sha512: files[0].sha512, files };
    writeFileSync(join(dir, 'latest-mac.yml'), stringify(metadata));
    return { dir, metadata };
  }
  it('Mac 校验 Intel 与 Apple Silicon 的 DMG、ZIP 和差分文件，校验和不覆盖 Windows', async () => {
    const { dir } = macFixture();
    writeFileSync(join(dir, 'SHA256SUMS'), 'Windows 校验和');
    const files = await verifyRelease(dir, '0.1.1', 'mac');
    expect(files).toContain('Fynvra-0.1.1-mac-x64.zip.blockmap');
    expect(files).toContain('Fynvra-0.1.1-mac-arm64.dmg');
    expect(files).toContain('latest-mac.yml');
    expect(files).toContain('SHA256SUMS-mac');
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe('Windows 校验和');
    expect(readFileSync(join(dir, 'SHA256SUMS-mac'), 'utf8').trim().split('\n')).toHaveLength(7);
  });
  it('Mac 手动包只公布双架构安装文件与校验和，不发布自动更新元数据', async () => {
    const { dir } = macFixture();
    for (const arch of ['x64', 'arm64']) rmSync(join(dir, `Fynvra-0.1.1-mac-${arch}.zip.blockmap`));
    const files = await verifyRelease(dir, '0.1.1', 'mac-manual');
    expect(files).toEqual([
      'Fynvra-0.1.1-mac-x64.zip',
      'Fynvra-0.1.1-mac-x64.dmg',
      'Fynvra-0.1.1-mac-arm64.zip',
      'Fynvra-0.1.1-mac-arm64.dmg',
      'SHA256SUMS-mac',
    ]);
    const sums = readFileSync(join(dir, 'SHA256SUMS-mac'), 'utf8');
    expect(sums.trim().split('\n')).toHaveLength(4);
    expect(sums).not.toContain('latest-mac.yml');
    expect(sums).not.toContain('.blockmap');
  });
  it('Mac 缺少架构、ZIP、差分文件或包被损坏时拒绝发布', async () => {
    for (const name of ['Fynvra-0.1.1-mac-arm64.zip', 'Fynvra-0.1.1-mac-x64.zip.blockmap']) {
      const { dir } = macFixture();
      rmSync(join(dir, name));
      await expect(verifyRelease(dir, '0.1.1', 'mac')).rejects.toThrow();
    }
    const { dir } = macFixture();
    writeFileSync(join(dir, 'Fynvra-0.1.1-mac-x64.dmg'), '损坏的包');
    await expect(verifyRelease(dir, '0.1.1', 'mac')).rejects.toThrow();
  });
  it('Mac 元数据不能重复架构、混入路径或用 DMG 充当自动更新 ZIP', async () => {
    for (const mutate of [
      (data: ReturnType<typeof macFixture>['metadata']) => {
        data.files[2] = data.files[0];
      },
      (data: ReturnType<typeof macFixture>['metadata']) => {
        data.files[0].url = '../outside.zip';
      },
      (data: ReturnType<typeof macFixture>['metadata']) => {
        data.path = data.files[1].url;
        data.sha512 = data.files[1].sha512;
      },
    ]) {
      const { dir, metadata } = macFixture();
      mutate(metadata);
      writeFileSync(join(dir, 'latest-mac.yml'), stringify(metadata));
      await expect(verifyRelease(dir, '0.1.1', 'mac')).rejects.toThrow();
    }
  });
  it('核对版本、安装包哈希和大小、差分文件，生成可下载文件清单和 SHA256SUMS', async () => {
    const { dir, name } = fixture();
    expect(await verifyRelease(dir, '0.1.1')).toEqual([
      name,
      `${name}.blockmap`,
      'latest.yml',
      'SHA256SUMS',
    ]);
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n')).toHaveLength(3);
  });
  it('版本错位、损坏、缺少差分文件时拒绝发布', async () => {
    const { dir, name } = fixture();
    await expect(verifyRelease(dir, '0.1.2')).rejects.toThrow();
    writeFileSync(join(dir, name), '损坏后的文件');
    await expect(verifyRelease(dir, '0.1.1')).rejects.toThrow();
    const second = fixture();
    rmSync(join(second.dir, `${second.name}.blockmap`));
    await expect(verifyRelease(second.dir, '0.1.1')).rejects.toThrow();
  });
  it('拒绝元数据中的远程地址、越界路径和不一致的旧格式哈希', async () => {
    for (const url of ['../outside.exe', 'https://example.com/setup.exe']) {
      const { dir, metadata } = fixture();
      metadata.files[0].url = url;
      writeFileSync(join(dir, 'latest.yml'), stringify(metadata));
      await expect(verifyRelease(dir, '0.1.1')).rejects.toThrow();
    }
    const { dir, metadata } = fixture();
    metadata.sha512 = 'wrong';
    writeFileSync(join(dir, 'latest.yml'), stringify(metadata));
    await expect(verifyRelease(dir, '0.1.1')).rejects.toThrow();
  });
});
