import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseSettings, type Settings } from '@shared/types/settings';

/** 合并写入的防抖窗口：窗口内的多次修改只落盘最后一次。 */
export const SETTINGS_WRITE_DEBOUNCE_MS = 500;

export interface SettingsFileOptions {
  filePath: string;
  debounceMs?: number;
}

export interface SettingsFile {
  /** 内存中的最新快照；首次调用时读盘并收窄，文件缺失或损坏则为默认值。 */
  read(): Settings;
  /** 用纯函数产出新快照；内容有变化时安排防抖落盘。 */
  update(mutate: (current: Settings) => Settings): { settings: Settings; changed: boolean };
  /** 立即落盘待写内容。失败返回 false 并保留待写状态，供下次重试。 */
  flush(): boolean;
}

/** settings.json 的唯一读写入口（Main 持有）：内存缓存 + 防抖 + 原子替换。 */
export function createSettingsFile({
  filePath,
  debounceMs = SETTINGS_WRITE_DEBOUNCE_MS,
}: SettingsFileOptions): SettingsFile {
  let cache: Settings | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const read = (): Settings => {
    cache ??= parseSettings(readJson(filePath));
    return cache;
  };

  const write = (): boolean => {
    if (!dirty || !cache) return true;
    try {
      writeAtomic(filePath, `${JSON.stringify(cache, null, 2)}\n`);
      dirty = false;
      return true;
    } catch (error) {
      console.error('[settings] 写入 settings.json 失败', error);
      return false;
    }
  };

  return {
    read,
    update(mutate) {
      const current = read();
      const next = parseSettings(mutate(current));
      if (JSON.stringify(next) === JSON.stringify(current)) {
        return { settings: current, changed: false };
      }
      cache = next;
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        write();
      }, debounceMs);
      return { settings: next, changed: true };
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return write();
    },
  };
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 先写同目录临时文件再 rename 覆盖：进程中途崩溃也不会留下半截 settings.json。 */
function writeAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
