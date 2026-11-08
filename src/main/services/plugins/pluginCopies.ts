import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { translate } from '../../i18n';

/** 副本上限：超过任一项就中止复制，提示改用引用模式 */
export const MAX_COPY_BYTES = 200 * 1024 * 1024;
export const MAX_COPY_FILES = 20_000;

export type CopyOutcome = { ok: true; path: string } | { ok: false; error: string };

class CopyLimitError extends Error {}

/** `child` resolve 后严格位于 `root` 之内（不等于 root 本身） */
export function isStrictlyInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 副本加载路径所在的插件目录（`<root>/<dir>`）；不在副本根目录内时返回 null。
 * 删除、覆盖前都要经过这一步，保证只动副本根目录里的东西。
 */
export function copyDirOf(root: string, loadPath: string): string | null {
  if (!isStrictlyInside(root, loadPath)) return null;
  const first = relative(resolve(root), resolve(loadPath)).split(sep)[0];
  if (!first || first === '..' || first.startsWith('.tmp-') || first.startsWith('.old-')) {
    return null;
  }
  return join(resolve(root), first);
}

/** 在副本根目录里挑一个磁盘上还不存在的目录名：`<base>`、`<base>-2`……绝不复用已存在的目录 */
export async function freeCopyDirName(root: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!(await exists(join(root, name)))) return name;
  }
}

/**
 * 把本地插件（单个文件或目录）复制为 `<root>/<dirName>`：先复制到 `<root>/.tmp-<uuid>`，成功后再 rename；
 * 失败清理临时目录。返回实际加载路径：目录为 `<root>/<dirName>`，文件为 `<root>/<dirName>/<原文件名>`。
 * `dirName` 须是 freeCopyDirName 挑出的不存在的名字。
 */
export async function copyPluginInto(
  root: string,
  source: string,
  dirName: string
): Promise<CopyOutcome> {
  await mkdir(root, { recursive: true });
  const staged = await stage(root, source);
  if (!staged.ok) return staged;
  const target = join(root, dirName);
  try {
    await rename(staged.tmp, target);
  } catch (error) {
    await rm(staged.tmp, { recursive: true, force: true });
    return { ok: false, error: copyFailed(error) };
  }
  return { ok: true, path: staged.fileName ? join(target, staged.fileName) : target };
}

/**
 * 从来源重新复制，替换已有副本目录 `copyDir`（须已经过 copyDirOf 校验）：新内容先进临时目录，
 * 旧副本改名为 `.old-<uuid>` 后再换入；任何一步失败都还原旧副本。
 */
export async function replaceCopy(
  root: string,
  copyDir: string,
  source: string
): Promise<CopyOutcome> {
  const staged = await stage(root, source);
  if (!staged.ok) return staged;
  const old = join(root, `.old-${randomUUID()}`);
  try {
    await rename(copyDir, old);
  } catch (error) {
    await rm(staged.tmp, { recursive: true, force: true });
    return { ok: false, error: copyFailed(error) };
  }
  try {
    await rename(staged.tmp, copyDir);
  } catch (error) {
    await rename(old, copyDir).catch(() => undefined);
    await rm(staged.tmp, { recursive: true, force: true });
    return { ok: false, error: copyFailed(error) };
  }
  await rm(old, { recursive: true, force: true }).catch(() => undefined);
  return { ok: true, path: staged.fileName ? join(copyDir, staged.fileName) : copyDir };
}

/** 删除副本目录；调用方须先用 copyDirOf 取得目录（保证在副本根目录内） */
export async function removeCopyDir(root: string, copyDir: string): Promise<void> {
  if (!isStrictlyInside(root, copyDir)) throw new Error(translate('plugins.outsideCopyRoot'));
  try {
    await rm(copyDir, { recursive: true, force: true });
  } catch (error) {
    // 只报错误码，不带副本内部路径
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(typeof code === 'string' ? code : 'unknown');
  }
}

type Staged = { ok: true; tmp: string; fileName: string | null } | { ok: false; error: string };

async function stage(root: string, source: string): Promise<Staged> {
  const tmp = join(root, `.tmp-${randomUUID()}`);
  try {
    const realSource = await realpath(source);
    const info = await stat(realSource);
    const budget = { bytes: 0, files: 0 };
    if (info.isDirectory()) {
      await copyTree(realSource, realSource, tmp, budget, new Set([realSource]));
      return { ok: true, tmp, fileName: null };
    }
    if (!info.isFile()) return { ok: false, error: translate('plugins.badFileType') };
    const fileName = basename(source);
    await mkdir(tmp, { recursive: true });
    charge(budget, info.size);
    await copyFile(realSource, join(tmp, fileName));
    return { ok: true, tmp, fileName };
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      error:
        error instanceof CopyLimitError ? translate('plugins.copyTooLarge') : copyFailed(error),
    };
  }
}

/**
 * 递归复制目录，跳过 `.git`。符号链接 / junction 的真实路径在源目录（`root`）内的跟随复制，指向源目录外或
 * 指回正在复制的上级目录（环）的跳过；pnpm node_modules 里的链接都指向目录内的 `.pnpm`，能正常复制。
 */
async function copyTree(
  root: string,
  dir: string,
  dest: string,
  budget: { bytes: number; files: number },
  ancestors: Set<string>
): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const from = join(dir, entry.name);
    const to = join(dest, entry.name);
    let real = from;
    let info = await lstat(from);
    if (info.isSymbolicLink()) {
      try {
        real = await realpath(from);
      } catch {
        continue; // 断链
      }
      if (real !== root && !isStrictlyInside(root, real)) continue;
      info = await stat(real);
    }
    if (info.isDirectory()) {
      if (ancestors.has(real)) continue;
      ancestors.add(real);
      await copyTree(root, real, to, budget, ancestors);
      ancestors.delete(real);
    } else if (info.isFile()) {
      charge(budget, info.size);
      await copyFile(real, to);
    }
  }
}

function charge(budget: { bytes: number; files: number }, size: number): void {
  budget.bytes += size;
  budget.files += 1;
  if (budget.bytes > MAX_COPY_BYTES || budget.files > MAX_COPY_FILES) throw new CopyLimitError();
}

/** 文件系统错误只取错误码，不带路径（路径可能是注册表以外的源目录内部文件或副本根目录） */
function copyFailed(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return translate('plugins.copyFailed', { error: typeof code === 'string' ? code : 'unknown' });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
