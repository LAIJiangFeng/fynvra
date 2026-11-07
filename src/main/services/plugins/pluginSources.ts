import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { translate } from '../../i18n';

/** 单文件插件允许的扩展名（pi 扩展） */
export const PLUGIN_FILE_EXTENSIONS = ['ts', 'js', 'mjs'] as const;

export type LocalPluginCheck =
  | { ok: true; name: string; path: string }
  | { ok: false; error: string };

/**
 * 校验本地插件：绝对路径、存在；目录按 pi 包加载，文件须是 .ts / .js / .mjs。
 * 名字取 package.json 的 name，没有则用目录名或去掉扩展名的文件名。只读，不改动用户文件。
 */
export async function inspectLocalPlugin(path: string): Promise<LocalPluginCheck> {
  if (!isAbsolute(path)) return { ok: false, error: translate('plugins.notAbsolute') };
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    return { ok: false, error: translate('plugins.pathMissing', { error: errorMessage(error) }) };
  }
  if (info.isDirectory()) return { ok: true, name: await pluginName(path), path };
  if (!info.isFile()) return { ok: false, error: translate('plugins.badFileType') };
  const ext = extname(path).slice(1).toLowerCase();
  if (!(PLUGIN_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: translate('plugins.badFileType') };
  }
  return { ok: true, name: basename(path, extname(path)), path };
}

/** 插件目录的显示名：package.json 的 name，否则目录名 */
export async function pluginName(dir: string): Promise<string> {
  try {
    const name = asRecord(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')))?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    // 没有或读不了 package.json：用目录名
  }
  return basename(dir);
}

/** pi 包管理器里本任务用到的部分 */
export interface PluginPackageManager {
  install(source: string): Promise<void>;
  remove(source: string): Promise<void>;
  getInstalledPath(source: string, scope: 'user'): string | undefined;
}

/**
 * 动态加载 pi 的 DefaultPackageManager（Main 启动路径上不 import pi）。agentDir / cwd 都用会话的 agentDir，
 * 设置用 pi 的内存 SettingsManager：不写 pi settings 文件，不读 ~/.pi。npm 包装到 `<agentDir>/npm`，
 * git 仓库克隆到 `<agentDir>/git`。
 */
export async function loadPackageManager(agentDir: string): Promise<PluginPackageManager> {
  const { DefaultPackageManager, SettingsManager } = await import(
    '@earendil-works/pi-coding-agent'
  );
  const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false });
  return new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
}

/** 包管理器的错误转成可读文案：缺 npm / git 时给出提示；只取 message，截断，不带环境变量。 */
export function packageManagerError(error: unknown, kind: 'npm' | 'git'): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return translate('plugins.toolMissing', { tool: kind });
  const message = errorMessage(error).split('\n')[0] ?? '';
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
