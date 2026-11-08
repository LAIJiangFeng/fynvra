import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { asRecord } from '@shared/guards';
import {
  type PluginEntry,
  type PluginImportCandidateView,
  parseRemotePluginSource,
} from '@shared/types/plugins';
import { translate } from '../../i18n';
import { samePath } from '../gitRepository';
import { locateImportSources, readTextIfExists } from '../providers/import/locate';
import { PLUGIN_FILE_EXTENSIONS, pluginName } from './pluginSources';

// 「从本机导入」插件：只读扫描原生 pi 的 agent 目录（`PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`），
// 列出 extensions/ 下的扩展与 settings.json 里声明的包 / 扩展路径。绝不执行或 import 扩展代码。

/** 一次扫描最多列出的候选 */
export const MAX_IMPORT_CANDIDATES = 200;

/** Main 内部保存的候选：本地为绝对路径，npm / git 为规整后的来源；Renderer 只拿到视图和 id */
export type PiImportCandidate = PluginImportCandidateView &
  ({ kind: 'local'; path: string } | { kind: 'npm' | 'git'; source: string });

export interface PiImportScan {
  candidates: PiImportCandidate[];
  warnings: string[];
}

const isHidden = (name: string) => name.startsWith('.');
const hasPluginExt = (path: string) =>
  (PLUGIN_FILE_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase());

/**
 * 扫描 pi 的扩展与包。文件或目录不存在时静默跳过；settings.json 损坏只记一条 warning（只写文件名）。
 * `existing` 是 Fynvra 已登记的插件，用来标记 duplicateOf。
 */
export async function scanPiPlugins(options: {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  existing: readonly PluginEntry[];
  platform?: NodeJS.Platform;
}): Promise<PiImportScan> {
  const { home, env, existing, platform = process.platform } = options;
  const settingsPath = locateImportSources(home, env).piSettings;
  const agentDir = dirname(settingsPath);
  const warnings: string[] = [];
  const candidates: PiImportCandidate[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const display = (path: string) => {
    const rel = relative(home, path);
    if (rel === '') return '~';
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
    return `~${sep}${rel}`;
  };
  const pathKey = (path: string) => {
    const resolved = resolve(path);
    return `path:${platform === 'win32' ? resolved.toLowerCase() : resolved}`;
  };
  const full = () => {
    if (candidates.length < MAX_IMPORT_CANDIDATES) return false;
    truncated = true;
    return true;
  };

  const addLocal = async (path: string, form: 'file' | 'dir') => {
    if (full()) return;
    const key = pathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    const name = form === 'file' ? basename(path, extname(path)) : await pluginName(path);
    const duplicate = existing.find(
      (entry) =>
        (entry.sourcePath !== undefined && sameResolved(entry.sourcePath, path, platform)) ||
        (entry.kind === 'local' && sameResolved(entry.source, path, platform)) ||
        (entry.kind === 'local' && sameResolved(entry.path, path, platform))
    );
    candidates.push({
      id: randomUUID(),
      kind: 'local',
      form,
      path,
      name,
      display: display(path),
      ...(duplicate ? { duplicateOf: duplicate.name } : {}),
    });
  };

  const addRemote = (source: string, kind: 'npm' | 'git') => {
    if (full()) return;
    const key = `source:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    const duplicate = existing.find((entry) => entry.kind !== 'local' && entry.source === source);
    candidates.push({
      id: randomUUID(),
      kind,
      source,
      name: remoteName(source, kind),
      display: source,
      ...(duplicate ? { duplicateOf: duplicate.name } : {}),
    });
  };

  /** 本地路径：文件须是扩展文件，目录按 pi 包；不存在或类型不对就跳过 */
  const addLocalPath = async (raw: string) => {
    const path = resolve(agentDir, expandHome(raw, home));
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) await addLocal(path, 'dir');
    else if (info?.isFile() && hasPluginExt(path)) await addLocal(path, 'file');
  };

  // 1. <agentDir>/extensions/：直接放的 .ts / .js 文件，以及含 index.ts / index.js 的子目录
  const extensionsDir = join(agentDir, 'extensions');
  const entries = await readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    const path = join(extensionsDir, entry.name);
    const info = await stat(path).catch(() => null); // 跟随符号链接
    if (info?.isFile() && hasPluginExt(path)) {
      await addLocal(path, 'file');
    } else if (info?.isDirectory() && (await hasIndexEntry(path))) {
      await addLocal(path, 'dir');
    }
  }

  // 2. <agentDir>/settings.json 的 packages 与 extensions
  let settings: Record<string, unknown> | null = null;
  try {
    const text = await readTextIfExists(settingsPath);
    if (text !== null) {
      settings = asRecord(JSON.parse(text));
      if (!settings) throw new Error('not an object');
    }
  } catch {
    warnings.push(translate('plugins.importSettingsCorrupt', { file: 'settings.json' }));
    settings = null;
  }
  let unsupported = 0;
  if (settings && Array.isArray(settings.packages)) {
    for (const item of settings.packages) {
      const raw = typeof item === 'string' ? item : asRecord(item)?.source;
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const source = raw.trim();
      if (REMOTE_PREFIX.test(source)) {
        const parsed = parseRemotePluginSource(source);
        if (parsed) addRemote(parsed.source, parsed.kind);
        else unsupported += 1;
      } else {
        await addLocalPath(source);
      }
    }
  }
  if (settings && Array.isArray(settings.extensions)) {
    for (const item of settings.extensions) {
      if (typeof item !== 'string') continue;
      // `builtin:*`、`-path` / `!pattern` 排除项与通配符不是可导入的路径；`+path` 去掉前缀
      let path = item.trim();
      if (path.startsWith('+')) path = path.slice(1);
      if (!path || /^[-!]/.test(path) || /^builtin:/i.test(path) || /[*?[\]{}]/.test(path)) {
        continue;
      }
      await addLocalPath(path);
    }
  }
  if (unsupported > 0) {
    warnings.push(translate('plugins.importUnsupportedSources', { count: unsupported }));
  }
  if (truncated) warnings.push(translate('plugins.importTooMany', { max: MAX_IMPORT_CANDIDATES }));
  return { candidates, warnings };
}

/** 看起来是远程来源的（npm、git、URL、scp 写法）；其余按本地路径处理 */
const REMOTE_PREFIX = /^(?:npm:|git:|[a-z][a-z0-9+.-]*:\/\/|git@)/i;

function sameResolved(a: string, b: string, platform: NodeJS.Platform): boolean {
  return samePath(resolve(a), resolve(b), platform);
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

async function hasIndexEntry(dir: string): Promise<boolean> {
  for (const name of ['index.ts', 'index.js']) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) return true;
  }
  return false;
}

/** npm：包名（去掉版本）；git：仓库路径最后一段（去掉 @ref 与 .git） */
function remoteName(source: string, kind: 'npm' | 'git'): string {
  if (kind === 'npm') {
    const spec = source.slice(4);
    const at = spec.indexOf('@', 1);
    return at > 0 ? spec.slice(0, at) : spec;
  }
  let path = source.startsWith('git:') ? source.slice(4) : source.replace(/^https:\/\//, '');
  path = path.replace(/[?#].*$/, '');
  const at = path.lastIndexOf('@');
  if (at > path.indexOf('/')) path = path.slice(0, at);
  const last = path.replace(/\/+$/, '').split('/').pop() ?? path;
  return last.replace(/\.git$/i, '') || source;
}
