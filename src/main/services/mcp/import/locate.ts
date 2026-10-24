import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpImportSource } from '@shared/types/llm';
import type { Env } from './readers/common';

// 来源定位：各来源在本机的候选位置，以及把 CC Switch 的库读出来。只做 IO，不解释内容。
// 每个来源一个候选路径列表，不存在的跳过（没装这个工具不算问题）；其它读错误照常抛出，由 scan 记成 warning。
// 文本文件的读取与模型服务导入共用 readTextIfExists（不存在返回 null，去掉 BOM）。

export { readTextIfExists } from '../../providers/import/locate';

export interface LocateOptions {
  home: string;
  env: Env;
  platform: NodeJS.Platform;
}

/** 各来源的候选路径，按读取顺序。 */
export function locateMcpSources({
  home,
  env,
  platform,
}: LocateOptions): Readonly<Record<McpImportSource, readonly string[]>> {
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  // VS Code 的用户目录：Windows 在 %APPDATA%，macOS 在 Application Support，其它平台在 XDG 配置目录
  const appConfig =
    platform === 'win32'
      ? env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : xdgConfig;
  return {
    'claude-code': [join(home, '.claude.json'), join(home, '.claude', 'settings.json')],
    codex: [join(home, '.codex', 'config.toml')],
    grok: [join(home, '.grok', 'config.toml')],
    gemini: [join(home, '.gemini', 'settings.json')],
    cursor: [join(home, '.cursor', 'mcp.json')],
    vscode: ['Code', 'Code - Insiders'].map((product) =>
      join(appConfig, product, 'User', 'mcp.json')
    ),
    // OpenCode 在各平台都用 XDG 风格的 ~/.config/opencode
    opencode: ['opencode.json', 'opencode.jsonc'].map((name) => join(xdgConfig, 'opencode', name)),
    'cc-switch': [join(home, '.cc-switch', 'cc-switch.db')],
  };
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * CC Switch 库里 mcp_servers 表的全部行；库不存在返回 null。读法与模型服务导入相同：
 * 先把库文件（有 -wal 就一起）复制到临时目录再只读打开，不和运行中的 CC Switch 争锁，也绝不写它的库；
 * 读完关闭并删除副本。-shm 不复制：它只是 WAL 的索引，SQLite 会在副本旁重建。
 */
export async function readCcSwitchMcpRows(
  dbPath: string,
  tempRoot: string = tmpdir()
): Promise<Record<string, unknown>[] | null> {
  try {
    await stat(dbPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  const dir = await mkdtemp(join(tempRoot, 'fynvra-cc-switch-mcp-'));
  try {
    const copy = join(dir, 'cc-switch.db');
    await copyFile(dbPath, copy);
    await copyFile(`${dbPath}-wal`, `${copy}-wal`).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    // 按需加载：Node 23 首次加载 node:sqlite 会打 ExperimentalWarning；Electron 45 的 Node 24.22 不会
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_servers'")
        .get();
      if (!table) throw new Error('数据库里没有 mcp_servers 表');
      return db.prepare('SELECT * FROM mcp_servers').all();
    } finally {
      db.close();
    }
  } finally {
    // 副本里有 env 明文：删不掉（如被杀毒软件占着）也只告警，不影响已经读到的结果
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      console.warn(`[mcp-import] 删除 CC Switch 库的临时副本失败：${dir}`, error);
    });
  }
}
