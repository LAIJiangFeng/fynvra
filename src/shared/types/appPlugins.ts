// Fynvra 插件契约 v1.1（ARCHITECTURE §7.12「Fynvra 插件」）：清单解析、RPC 消息、视图类型与 IPC 入参收窄。
// 本文件只放类型和纯函数，不得 import Node / Electron。
import { asRecord } from '../guards';
import {
  APP_PLUGIN_PERMISSIONS,
  type AppPluginPermission,
  filterPermissions,
  isMarketPluginId,
  isMarketVersion,
  isSafeMarketPath,
  type MarketTier,
} from './pluginMarket';

export { APP_PLUGIN_PERMISSIONS, type AppPluginPermission };

/** 单条 RPC 消息上限 1 MB；调用默认 30 秒超时 */
export const MAX_RPC_MESSAGE_BYTES = 1024 * 1024;
export const RPC_TIMEOUT_MS = 30_000;

/** `fynvra-plugin.json` 里 kind 为 fynvra 的清单（只取运行时用到的字段） */
export interface AppPluginManifest {
  id: string;
  name: string;
  version: string;
  kind: 'fynvra';
  host: { main: string };
  permissions: AppPluginPermission[];
}

/** host.main：包内相对 POSIX 路径，`.js` / `.mjs`，不含 `..`、反斜杠、空段，不以 `/` 开头 */
export function isAppPluginMain(value: unknown): value is string {
  return isSafeMarketPath(value) && /\.(m?js)$/.test(value);
}

/** 解析 kind 为 fynvra 的清单；kind 不对、host.main 缺失或越界等一律 null */
export function parseAppPluginManifest(raw: unknown): AppPluginManifest | null {
  const record = asRecord(raw);
  if (record?.schemaVersion !== 1 || record.kind !== 'fynvra') return null;
  const { id, name, version, host, permissions } = record;
  if (!isMarketPluginId(id) || !isMarketVersion(version)) return null;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 60) return null;
  const main = asRecord(host)?.main;
  if (!isAppPluginMain(main)) return null;
  if (permissions !== undefined && !Array.isArray(permissions)) return null;
  return {
    id,
    name,
    version,
    kind: 'fynvra',
    host: { main },
    permissions: filterPermissions('fynvra', permissions ?? []) as AppPluginPermission[],
  };
}

export type AppPluginStatus = 'starting' | 'running' | 'stopped' | 'crashed';
export type AppPluginSource = 'market' | 'local';

/** 给 Renderer 的视图（不含任何路径） */
export interface AppPluginView {
  id: string;
  name: string;
  version: string;
  /** 本地来源为 null */
  tier: MarketTier | null;
  source: AppPluginSource;
  enabled: boolean;
  status: AppPluginStatus;
  lastError?: string;
  permissions: AppPluginPermission[];
  revokedReason?: string;
}

// ---- RPC（parentPort） ----

/** Main → 宿主进程 */
export type HostInboundMessage =
  | { type: 'init'; pluginId: string; entryPath: string; dataDir: string }
  | { type: 'deactivate' }
  | { type: 'res'; id: number; ok: true; result: unknown }
  | { type: 'res'; id: number; ok: false; error: string }
  | { type: 'evt'; event: string; payload: unknown }
  | { type: 'call'; id: number; name: string; args: unknown };

/** 宿主进程 → Main */
export type HostOutboundMessage =
  | { type: 'activated' }
  | { type: 'activate-failed'; error: string }
  | { type: 'req'; id: number; method: string; params: unknown }
  | { type: 'ret'; id: number; ok: true; result: unknown }
  | { type: 'ret'; id: number; ok: false; error: string };

const isRpcId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 100;

/** 宿主进程收窄 Main 发来的消息 */
export function parseHostInbound(raw: unknown): HostInboundMessage | null {
  const record = asRecord(raw);
  if (!record) return null;
  switch (record.type) {
    case 'init': {
      const { pluginId, entryPath, dataDir } = record;
      if (!isMarketPluginId(pluginId)) return null;
      if (typeof entryPath !== 'string' || typeof dataDir !== 'string') return null;
      return { type: 'init', pluginId, entryPath, dataDir };
    }
    case 'deactivate':
      return { type: 'deactivate' };
    case 'res':
      if (!isRpcId(record.id)) return null;
      if (record.ok === true)
        return { type: 'res', id: record.id, ok: true, result: record.result };
      return { type: 'res', id: record.id, ok: false, error: String(record.error ?? 'error') };
    case 'evt':
      return isName(record.event)
        ? { type: 'evt', event: record.event, payload: record.payload }
        : null;
    case 'call':
      return isRpcId(record.id) && isName(record.name)
        ? { type: 'call', id: record.id, name: record.name, args: record.args }
        : null;
    default:
      return null;
  }
}

/** Main 收窄宿主进程发来的消息 */
export function parseHostOutbound(raw: unknown): HostOutboundMessage | null {
  const record = asRecord(raw);
  if (!record) return null;
  switch (record.type) {
    case 'activated':
      return { type: 'activated' };
    case 'activate-failed':
      return { type: 'activate-failed', error: String(record.error ?? 'error').slice(0, 1000) };
    case 'req':
      return isRpcId(record.id) && isName(record.method)
        ? { type: 'req', id: record.id, method: record.method, params: record.params }
        : null;
    case 'ret':
      if (!isRpcId(record.id)) return null;
      if (record.ok === true)
        return { type: 'ret', id: record.id, ok: true, result: record.result };
      return { type: 'ret', id: record.id, ok: false, error: String(record.error ?? 'error') };
    default:
      return null;
  }
}

// ---- IPC 入参 ----

/** 无参数或 `{}` */
export function isEmptyAppPluginArgs(raw: unknown): boolean {
  if (raw === undefined) return true;
  const record = asRecord(raw);
  return record !== null && Object.keys(record).length === 0;
}

/** `{ id }`，拒绝多余键 */
export function parseAppPluginIdInput(raw: unknown): { id: string } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'id')) return null;
  return isMarketPluginId(record.id) ? { id: record.id } : null;
}

/** `{ id, enabled }`，拒绝多余键 */
export function parseAppPluginToggleInput(raw: unknown): { id: string; enabled: boolean } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'id' && key !== 'enabled')) return null;
  const { id, enabled } = record;
  return isMarketPluginId(id) && typeof enabled === 'boolean' ? { id, enabled } : null;
}
