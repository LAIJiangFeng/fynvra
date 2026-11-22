// 只读取已安装插件目录里的 README.md（Fynvra 插件与 PI 插件共用）：不执行代码、不跟随符号链接、有大小上限。
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginReadmeResult } from '@shared/types/plugins';

export const PLUGIN_README_MAX_BYTES = 256 * 1024;

const none = { ok: false, code: 'none', error: 'none' } as const;
const tooLarge = { ok: false, code: 'too-large', error: 'too-large' } as const;

/** 错误里只带错误码，不带本机路径 */
function failed(code: string): PluginReadmeResult {
  return { ok: false, code: 'failed', error: code };
}

export async function readPluginReadme(dir: string): Promise<PluginReadmeResult> {
  try {
    // 单文件插件（path 指向文件）没有说明
    if (!(await stat(dir)).isDirectory()) return none;
    const name = (await readdir(dir)).find((entry) => entry.toLowerCase() === 'readme.md');
    if (!name) return none;
    const file = join(dir, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) return failed('ESYMLINK');
    if (!info.isFile()) return none;
    if (info.size > PLUGIN_README_MAX_BYTES) return tooLarge;
    const data = await readFile(file);
    // lstat 与读取之间文件可能被替换，读完再校验一次大小
    if (data.length > PLUGIN_README_MAX_BYTES) return tooLarge;
    return { ok: true, text: data.toString('utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return none;
    return failed(typeof code === 'string' ? code : 'EUNKNOWN');
  }
}
