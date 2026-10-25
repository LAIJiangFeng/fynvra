import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
type Version = [number, number, number];

function parseVersion(value: string): Version {
  if (!STABLE_VERSION.test(value)) throw new Error(`无效的稳定版本: ${value}`);
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('版本号超出安全范围');
  return parts as Version;
}

function compare(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** 版本只写进构建产物和标签，不让机器人提交版本号触发发布循环。 */
export function planRelease(
  packageVersion: string,
  tags: { name: string; sha: string }[],
  sourceSha: string
): { version: string; tag: string } {
  parseVersion(packageVersion);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('无效的发布提交');
  const stable = tags
    .filter(({ name }) => name.startsWith('v') && STABLE_VERSION.test(name.slice(1)))
    .map((tag) => ({ ...tag, version: tag.name.slice(1) }))
    .sort((a, b) => compare(b.version, a.version));
  const latest = stable[0];
  const existing = stable.find((tag) => tag.sha === sourceSha);
  if (existing) {
    if (latest && compare(existing.version, latest.version) < 0) {
      throw new Error('此提交已被更新的发布取代，不能重新标记为最新版');
    }
    return { version: existing.version, tag: existing.name };
  }
  let version = packageVersion;
  if (!latest || compare(packageVersion, latest.version) <= 0) {
    const [major, minor, patch] = parseVersion(latest?.version ?? packageVersion);
    version = `${major}.${minor}.${patch + 1}`;
    parseVersion(version);
  }
  return { version, tag: `v${version}` };
}

async function hashFile(file: string, algorithm: string, encoding: 'base64' | 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('发布元数据格式无效');
  return value as Record<string, unknown>;
}

/** 发布前校验真正的文件，不能仅凭打包命令启动或元数据存在就认为成功。 */
export async function verifyRelease(
  directory: string,
  version: string,
  platform: 'win' | 'mac' = 'win'
): Promise<string[]> {
  parseVersion(version);
  if (platform !== 'win' && platform !== 'mac') throw new Error('未知的发布平台');
  const { parse } = await import('yaml');
  const metadataName = platform === 'mac' ? 'latest-mac.yml' : 'latest.yml';
  const sumsName = platform === 'mac' ? 'SHA256SUMS-mac' : 'SHA256SUMS';
  const installers =
    platform === 'mac'
      ? ['x64', 'arm64'].flatMap((arch) =>
          ['zip', 'dmg'].map((extension) => `Fynvra-${version}-mac-${arch}.${extension}`)
        )
      : [`Fynvra-${version}-x64-setup.exe`];
  const updatePackages = installers.filter((name) => !name.endsWith('.dmg'));
  const metadata = record(parse(readFileSync(join(directory, metadataName), 'utf8')));
  if (
    metadata.version !== version ||
    typeof metadata.path !== 'string' ||
    !updatePackages.includes(metadata.path) ||
    !Array.isArray(metadata.files) ||
    metadata.files.length !== installers.length
  ) {
    throw new Error('更新版本或安装包名称不匹配');
  }
  const remaining = new Set(installers);
  for (const raw of metadata.files) {
    const file = record(raw);
    if (typeof file.url !== 'string' || !remaining.delete(file.url)) {
      throw new Error('更新元数据必须完整且不重复地引用本次构建的本地安装包');
    }
    const path = join(directory, file.url);
    const info = statSync(path);
    if (!info.isFile() || info.size === 0 || file.size !== info.size)
      throw new Error('安装包大小不匹配');
    const sha512 = await hashFile(path, 'sha512', 'base64');
    if (file.sha512 !== sha512 || (metadata.path === file.url && metadata.sha512 !== sha512))
      throw new Error('安装包 SHA512 不匹配');
  }
  const files = [...installers, ...updatePackages.map((name) => `${name}.blockmap`), metadataName];
  const sums: string[] = [];
  for (const name of files) {
    const path = join(directory, name);
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) throw new Error(`发布文件缺失或为空: ${name}`);
    sums.push(`${await hashFile(path, 'sha256', 'hex')}  ${name}`);
  }
  writeFileSync(join(directory, sumsName), `${sums.join('\n')}\n`);
  return [...files, sumsName];
}

async function main() {
  if (process.argv[2] === 'verify') {
    const [, , , directory, version, platform = 'win'] = process.argv;
    if (!directory || !version || (platform !== 'win' && platform !== 'mac'))
      throw new Error('用法: node scripts/release.ts verify <目录> <版本> [win|mac]');
    process.stdout.write(`${(await verifyRelease(directory, version, platform)).join('\n')}\n`);
    return;
  }
  if (process.argv[2] !== 'plan') throw new Error('用法: node scripts/release.ts plan');
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const sourceSha =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const refs = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(*objectname)', 'refs/tags'],
    { encoding: 'utf8' }
  );
  const tags = refs
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, object, peeled] = line.trim().split('\t');
      return { name, sha: peeled || object };
    });
  const result = planRelease(packageVersion, tags, sourceSha);
  // 旧失败任务在新版本发布后重跑，不能把旧代码包装成更高版本。
  for (const tag of tags.filter(
    ({ name }) => name.startsWith('v') && STABLE_VERSION.test(name.slice(1))
  )) {
    execFileSync('git', ['merge-base', '--is-ancestor', tag.sha, sourceSha]);
  }
  const output = `version=${result.version}\ntag=${result.tag}\nsha=${sourceSha}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
