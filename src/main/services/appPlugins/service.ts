// Fynvra 插件的登记、包目录与私有数据的增删改（ARCHITECTURE §7.12「Fynvra 插件」）：
// 开发版本地安装 / 重新复制、删除、启停，以及给市场用的安装 / 更新 / 撤回入口。写盘与删除只在各自根目录内。
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage } from '@shared/guards';
import {
  type AppPluginManifest,
  type AppPluginPermission,
  type AppPluginView,
  parseAppPluginManifest,
} from '@shared/types/appPlugins';
import type { MarketTier } from '@shared/types/pluginMarket';
import { translate } from '../../i18n';
import {
  copyDirOf,
  copyPluginInto,
  freeCopyDirName,
  isStrictlyInside,
  removeCopyDir,
  replaceCopy,
  swapCopyDir,
} from '../plugins/pluginCopies';
import { MAX_MANIFEST_BYTES, readSmallTextFile } from '../plugins/providerScan';
import type { AppPluginRecord, AppPluginRegistry } from './registry';
import type { AppPluginRuntime } from './runtime';
import type { PluginSecretStore } from './secrets';

const MANIFEST = 'fynvra-plugin.json';

export type AppPluginActionResult =
  | { ok: true; plugin: AppPluginView }
  | { ok: false; code: 'invalid' | 'failed'; error: string };

export type ManifestCheck = { ok: true; manifest: AppPluginManifest } | { ok: false; code: string };

/** 读并校验目录里的清单：kind 为 fynvra、host.main 合法且确实是文件 */
export async function readAppPluginManifest(dir: string): Promise<ManifestCheck> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
  } catch {
    return { ok: false, code: 'manifest-missing' };
  }
  const manifest = parseAppPluginManifest(raw);
  if (!manifest) return { ok: false, code: 'manifest-invalid' };
  const main = join(dir, ...manifest.host.main.split('/'));
  if (!isStrictlyInside(dir, main)) return { ok: false, code: 'host-main-invalid' };
  try {
    if (!(await stat(main)).isFile()) return { ok: false, code: 'host-main-missing' };
  } catch {
    return { ok: false, code: 'host-main-missing' };
  }
  return { ok: true, manifest };
}

/**
 * 只取清单的简介（给旧登记补字段）：清单必须是普通文件（不跟随符号链接）、不超过 64 KB。
 * 不是普通文件、超长、解析失败或没有简介返回 undefined；读取失败时 reject（错误可能带路径）
 */
export async function readManifestDescription(dir: string): Promise<string | undefined> {
  const text = await readSmallTextFile(join(dir, MANIFEST), MAX_MANIFEST_BYTES);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parseAppPluginManifest(raw)?.description;
}

/** 市场调用的入口（market.ts 只认这个接口） */
export interface AppPluginMarketHost {
  /** 包根目录 `fynvra-plugins/` */
  root(): string;
  list(): Promise<AppPluginRecord[]>;
  /** 已换入 `path` 的新包：登记、启用并启动 */
  registerMarket(input: {
    id: string;
    name: string;
    version: string;
    sha256: string;
    tier: MarketTier;
    permissions: AppPluginPermission[];
    path: string;
    /** 清单简介 */
    description?: string;
  }): Promise<AppPluginView>;
  /** 用已校验的临时目录替换包目录：停进程 → 换目录 → 更新登记（清撤回原因）→ 启用的重新启动 */
  replaceMarket(
    id: string,
    tmp: string,
    patch: {
      name: string;
      version: string;
      sha256: string;
      tier: MarketTier;
      permissions: AppPluginPermission[];
      /** 清单简介；undefined 会清掉旧值 */
      description?: string;
    }
  ): Promise<AppPluginActionResult>;
  /** reason 非 null：停用、写原因；null：只清原因 */
  setRevoked(id: string, reason: string | null): Promise<void>;
}

export interface AppPluginService extends AppPluginMarketHost {
  views(): Promise<AppPluginView[]>;
  toggle(id: string, enabled: boolean): Promise<AppPluginActionResult>;
  remove(
    id: string
  ): Promise<{ ok: true } | { ok: false; code: 'invalid' | 'failed'; error: string }>;
  /** 开发版：从本地目录复制安装（调用方负责 isPackaged 检查与弹框） */
  addLocal(source: string): Promise<AppPluginActionResult>;
  /** 仅 local：从源目录重新复制 */
  recopy(id: string): Promise<AppPluginActionResult>;
}

export function createAppPluginService(deps: {
  registry: AppPluginRegistry;
  runtime: AppPluginRuntime;
  secrets: PluginSecretStore;
  /** `fynvra-plugins/` */
  root: () => string;
  /** `userData/fynvra-plugin-data` */
  dataRoot: string;
  onChanged: () => void;
  /** 删除时清掉插件在核心里的归属（渠道会话与 PR note；会话本身保留） */
  onRemoved?: (id: string) => Promise<void>;
}): AppPluginService {
  const { registry, runtime, secrets, root, dataRoot, onChanged, onRemoved } = deps;
  const invalid = (error: string) => ({ ok: false as const, code: 'invalid' as const, error });
  const failed = (error: string) => ({ ok: false as const, code: 'failed' as const, error });
  const manifestError = (code: string) =>
    invalid(translate('appPlugins.invalidManifest', { error: code }));

  async function viewOf(id: string): Promise<AppPluginView | null> {
    const record = await registry.get(id);
    return record ? runtime.view(record) : null;
  }

  /** 来源与包根目录互相包含时不复制 */
  function overlapsRoot(source: string): boolean {
    const base = resolve(root());
    const src = resolve(source);
    return src === base || isStrictlyInside(base, src) || isStrictlyInside(src, base);
  }

  return {
    root,
    list: () => registry.list(),
    async views() {
      return (await registry.list()).map((record) => runtime.view(record));
    },
    async toggle(id, enabled) {
      const updated = await runtime.setEnabled(id, enabled);
      if (!updated) return invalid(translate('appPlugins.notFound'));
      return { ok: true, plugin: runtime.view(updated) };
    },
    async remove(id) {
      const record = await registry.get(id);
      if (!record) return invalid(translate('appPlugins.notFound'));
      await runtime.stop(id);
      try {
        const dir = copyDirOf(root(), record.path);
        if (dir) await removeCopyDir(root(), dir);
        await removeCopyDir(dataRoot, join(dataRoot, id));
        await secrets.removePlugin(id);
        await onRemoved?.(id);
        await registry.remove(id);
      } catch (error) {
        onChanged();
        return failed(translate('appPlugins.removeFailed', { error: errorMessage(error) }));
      }
      onChanged();
      return { ok: true };
    },
    async addLocal(source) {
      const checked = await readAppPluginManifest(source);
      if (!checked.ok) return manifestError(checked.code);
      const { manifest } = checked;
      if (await registry.get(manifest.id)) {
        return invalid(translate('appPlugins.alreadyInstalled', { name: manifest.name }));
      }
      if (overlapsRoot(source)) return invalid(translate('plugins.sourceInCopyRoot'));
      const base = root();
      const copied = await copyPluginInto(base, source, await freeCopyDirName(base, manifest.id));
      if (!copied.ok) return failed(copied.error);
      // 复制会跳过指向源目录外的链接：在副本上再核一次入口
      const again = await readAppPluginManifest(copied.path);
      if (!again.ok || again.manifest.id !== manifest.id) {
        await removeCopyDir(base, copied.path).catch(() => undefined);
        return manifestError(again.ok ? 'manifest-mismatch' : again.code);
      }
      try {
        await registry.add({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          ...(manifest.description !== undefined ? { description: manifest.description } : {}),
          source: 'local',
          path: copied.path,
          enabled: true,
          permissions: manifest.permissions,
          sourcePath: resolve(source),
        });
      } catch (error) {
        await removeCopyDir(base, copied.path).catch(() => undefined);
        return failed(translate('appPlugins.installFailed', { error: errorMessage(error) }));
      }
      await runtime.start(manifest.id);
      onChanged();
      const view = await viewOf(manifest.id);
      return view ? { ok: true, plugin: view } : failed(translate('appPlugins.notFound'));
    },
    async recopy(id) {
      const record = await registry.get(id);
      if (!record) return invalid(translate('appPlugins.notFound'));
      if (record.source !== 'local' || !record.sourcePath) {
        return invalid(translate('appPlugins.notLocal'));
      }
      const base = root();
      const dir = copyDirOf(base, record.path);
      if (!dir) return invalid(translate('plugins.outsideCopyRoot'));
      const checked = await readAppPluginManifest(record.sourcePath);
      if (!checked.ok) return manifestError(checked.code);
      if (checked.manifest.id !== id) return manifestError('manifest-mismatch');
      if (overlapsRoot(record.sourcePath)) return invalid(translate('plugins.sourceInCopyRoot'));
      // 先停进程再换目录（Windows 上运行中的文件可能被占用）
      await runtime.stop(id);
      const copied = await replaceCopy(base, dir, record.sourcePath);
      if (copied.ok) {
        await registry.update(id, {
          name: checked.manifest.name,
          version: checked.manifest.version,
          // 清单删了简介时 undefined 会把旧值清掉
          description: checked.manifest.description,
          permissions: checked.manifest.permissions,
          path: copied.path,
        });
      }
      await runtime.start(id);
      onChanged();
      if (!copied.ok) return failed(copied.error);
      const view = await viewOf(id);
      return view ? { ok: true, plugin: view } : failed(translate('appPlugins.notFound'));
    },
    async registerMarket(input) {
      const { description, ...rest } = input;
      await registry.add({
        ...rest,
        ...(description !== undefined ? { description } : {}),
        source: 'market',
        enabled: true,
      });
      await runtime.start(input.id);
      onChanged();
      const view = await viewOf(input.id);
      if (!view) throw new Error('registered plugin disappeared');
      return view;
    },
    async replaceMarket(id, tmp, patch) {
      const record = await registry.get(id);
      if (!record) return invalid(translate('appPlugins.notFound'));
      const base = root();
      const dir = copyDirOf(base, record.path);
      if (!dir) return invalid(translate('plugins.outsideCopyRoot'));
      await runtime.stop(id);
      const swapped = await swapCopyDir(base, dir, tmp);
      if (swapped.ok) {
        await registry.update(id, { ...patch, path: dir, revokedReason: undefined });
      }
      // 换目录失败时旧版本已还原，照常重新启动
      await runtime.start(id);
      onChanged();
      if (!swapped.ok) return failed(swapped.error);
      const view = await viewOf(id);
      return view ? { ok: true, plugin: view } : failed(translate('appPlugins.notFound'));
    },
    async setRevoked(id, reason) {
      if (reason === null) {
        await registry.update(id, { revokedReason: undefined });
      } else {
        await runtime.stop(id);
        await registry.update(id, { enabled: false, revokedReason: reason });
      }
      onChanged();
    },
  };
}
