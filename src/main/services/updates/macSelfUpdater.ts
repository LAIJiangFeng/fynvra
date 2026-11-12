import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { accessSync, constants, createWriteStream, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { asRecord } from '@shared/guards';
import type { UpdaterDriver } from './service';

const RELEASES = 'https://github.com/LAIJiangFeng/fynvra/releases';
export const MANIFEST_URL = `${RELEASES}/latest/download/latest-mac-manual.yml`;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface MacUpdate {
  version: string;
  url: string;
  sha512: string;
  size: number;
}

export interface MacSelfUpdaterOptions {
  currentVersion: string;
  arch: string;
  /** process.execPath，用于定位当前 .app */
  execPath: string;
  tempDir: string;
  /** 传 Electron net.fetch，走系统代理 */
  fetch(url: string): Promise<Response>;
  quit(): void;
  notWritableMessage(): string;
}

/** 清单是 release.ts 生成的固定格式（JSON 写成的 YAML），逐字段收窄。 */
export function parseMacManifest(text: string, arch: string): MacUpdate {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Invalid Mac update manifest');
  }
  const manifest = asRecord(raw);
  const version = manifest?.version;
  if (typeof version !== 'string' || !STABLE.test(version) || !Array.isArray(manifest?.files))
    throw new Error('Invalid Mac update manifest');
  const file = manifest.files.map(asRecord).find((entry) => entry?.arch === arch);
  const url = `Fynvra-${version}-mac-${arch}.zip`;
  if (
    file?.url !== url ||
    typeof file.sha512 !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0
  )
    throw new Error(`Mac update manifest has no valid ${arch} package`);
  return { version, url, sha512: file.sha512, size: file.size };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  if (!STABLE.test(candidate) || !STABLE.test(current)) return false;
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index >= 0 && a[index] > b[index];
}

/** 当前 .app 位于 App Translocation、外置卷或不可写目录时拒绝替换。 */
export function installTarget(execPath: string): string | undefined {
  const bundle = /^(\/.+?\.app)\//.exec(execPath)?.[1];
  if (!bundle || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return;
  try {
    accessSync(dirname(bundle), constants.W_OK);
    accessSync(bundle, constants.W_OK);
    return bundle;
  } catch {
    return undefined;
  }
}

// 等旧进程退出后替换；新包写入失败则还原备份，最后重新打开应用。
export const INSTALL_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; source="$3"; backup="$4"; work="$5"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -ge 300 ] && exit 1
  sleep 0.2
done
rm -rf "$backup"
if mv "$target" "$backup"; then
  if /usr/bin/ditto "$source" "$target"; then
    rm -rf "$backup" "$work"
  else
    rm -rf "$target"
    mv "$backup" "$target"
  fi
fi
/usr/bin/open -n "$target"
`;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  );
}

/** 无 Apple 证书的 Mac 包不能走 Squirrel，自行下载、校验并在退出后替换 .app。 */
export function createMacSelfUpdater(options: MacSelfUpdaterOptions): UpdaterDriver {
  const root = join(options.tempDir, 'fynvra-update');
  let available: MacUpdate | undefined;
  let ready: { version: string; bundle: string; work: string } | undefined;
  const emitter = new EventEmitter();

  return Object.assign(emitter, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    allowPrerelease: false,
    async checkForUpdates() {
      const response = await options.fetch(MANIFEST_URL);
      if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}`);
      const update = parseMacManifest(await response.text(), options.arch);
      available = isNewerVersion(update.version, options.currentVersion) ? update : undefined;
      emitter.emit(available ? 'update-available' : 'update-not-available', {
        version: update.version,
      });
      return { updateInfo: { version: update.version } };
    },
    async downloadUpdate() {
      const update = available;
      if (!update) throw new Error('No update available');
      const work = join(root, update.version);
      const zip = join(work, update.url);
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      try {
        const response = await options.fetch(
          `${RELEASES}/download/v${update.version}/${update.url}`
        );
        if (!response.ok || !response.body)
          throw new Error(`Update download failed: HTTP ${response.status}`);
        const hash = createHash('sha512');
        const out = createWriteStream(zip);
        let received = 0;
        let percent = -1;
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            received += chunk.length;
            if (received > update.size) throw new Error('Update size mismatch');
            hash.update(chunk);
            if (!out.write(chunk)) await once(out, 'drain');
            const next = Math.floor((received / update.size) * 100);
            if (next !== percent) {
              percent = next;
              emitter.emit('download-progress', {
                percent,
                transferred: received,
                total: update.size,
              });
            }
          }
          out.end();
          await finished(out);
        } finally {
          out.destroy();
        }
        if (received !== update.size) throw new Error('Update size mismatch');
        if (hash.digest('base64') !== update.sha512) throw new Error('Update checksum mismatch');
        const extracted = join(work, 'app');
        await run('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
        const bundle = join(extracted, 'Fynvra.app');
        const plist = join(bundle, 'Contents', 'Info.plist');
        const version = await run('/usr/bin/plutil', [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          '-o',
          '-',
          plist,
        ]);
        if (version.trim() !== update.version) throw new Error('Downloaded app version mismatch');
        await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle]).catch(() => undefined);
        await rm(zip, { force: true });
        ready = { version: update.version, bundle, work };
      } catch (error) {
        await rm(work, { recursive: true, force: true });
        throw error;
      }
      emitter.emit('update-downloaded', { version: update.version });
      return [ready.bundle];
    },
    quitAndInstall() {
      if (!ready) throw new Error('No downloaded update');
      const target = installTarget(options.execPath);
      if (!target) throw new Error(options.notWritableMessage());
      const script = join(root, 'install.sh');
      writeFileSync(script, INSTALL_SCRIPT, { mode: 0o700 });
      const child = spawn(
        '/bin/sh',
        [script, String(process.pid), target, ready.bundle, join(root, 'backup.app'), ready.work],
        { detached: true, stdio: 'ignore' }
      );
      child.on('error', () => undefined); // 应用即将退出，此处只避免未处理事件崩溃
      child.unref();
      options.quit();
    },
  });
}
