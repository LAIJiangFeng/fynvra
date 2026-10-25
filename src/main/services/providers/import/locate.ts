import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translate } from '../../../i18n';

// 来源定位：各来源在本机的位置，以及把原始内容（文件文本 / 数据库行）读出来。只做 IO，不解释内容。
// 文件不存在返回 null（没装这个工具不算问题）；其它读错误照常抛出，由 scan 记成该来源的 warning。

export interface ImportSourcePaths {
  claudeSettings: string;
  codexConfig: string;
  codexAuth: string;
  ccSwitchDb: string;
}

export function locateImportSources(home: string): ImportSourcePaths {
  return {
    claudeSettings: join(home, '.claude', 'settings.json'),
    codexConfig: join(home, '.codex', 'config.toml'),
    codexAuth: join(home, '.codex', 'auth.json'),
    ccSwitchDb: join(home, '.cc-switch', 'cc-switch.db'),
  };
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** 文本文件；不存在返回 null。去掉 Windows 编辑器可能加的 UTF-8 BOM（JSON.parse 不认它）。 */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * CC Switch 库里 providers 表的全部行；库不存在返回 null。
 * 先把库文件（有 -wal 就一起）复制到临时目录再只读打开：不和运行中的 CC Switch 争锁，也绝不写它的库；
 * 读完关闭并删除副本。-shm 不复制：它只是 WAL 的索引，SQLite 会在副本旁重建。
 */
export async function readCcSwitchRows(
  dbPath: string,
  tempRoot: string = tmpdir()
): Promise<Record<string, unknown>[] | null> {
  try {
    await stat(dbPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  const dir = await mkdtemp(join(tempRoot, 'fynvra-cc-switch-'));
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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'")
        .get();
      if (!table) throw new Error(translate('importers.noTable', { table: 'providers' }));
      return db.prepare('SELECT * FROM providers').all();
    } finally {
      db.close();
    }
  } finally {
    // 副本里有 key：删不掉（如被杀毒软件占着）也只告警，不影响已经读到的结果
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      console.warn(`[provider-import] 删除 CC Switch 库的临时副本失败：${dir}`, error);
    });
  }
}
