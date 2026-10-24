import { type CoreFs, isNotFoundError } from '../fs';
import { errorMessage, joinPath, writeFileAtomic } from '../internal/files';
import type { Role } from '../types';
import { BUILTIN_ROLES, getBuiltinRole, isBuiltinRoleId } from './builtin';
import { isValidRoleId, parseRole } from './parseRole';

/** {@link RoleStore.save} 的结果。 */
export type SaveRoleResult = { ok: true; role: Role } | { ok: false; error: string };
/** {@link RoleStore.remove} 的结果。 */
export type RemoveRoleResult = { ok: true } | { ok: false; error: string };

/** 角色仓库：内置角色只读常驻，自定义角色可增删改。 */
export interface RoleStore {
  /** 全部角色：内置在前，自定义按 id 排序。 */
  list(): Promise<Role[]>;
  /** 按 id 取角色；不存在返回 `undefined`。 */
  get(id: string): Promise<Role | undefined>;
  /** 新建或覆盖自定义角色；先经 {@link parseRole} 校验，内置 id 拒绝。 */
  save(role: Role): Promise<SaveRoleResult>;
  /** 删除自定义角色；内置角色与不存在的角色返回错误。 */
  remove(id: string): Promise<RemoveRoleResult>;
}

/** {@link JsonFileRoleStore} 构造参数。 */
export interface JsonFileRoleStoreOptions {
  /** 注入的文件系统。 */
  fs: CoreFs;
  /** 角色目录，如 `userData/roles`；不存在时首次 save 创建。 */
  dir: string;
  /** 读到无效文件（读不了、坏 JSON、校验失败、文件名与 id 不符、占用内置 id）时回调，便于记日志；该文件被跳过。 */
  onInvalidFile?: ((file: string, error: string) => void) | undefined;
}

const SUFFIX = '.json';

/**
 * 每个自定义角色一个 `<dir>/<id>.json`（原子写）。内置角色不落盘、不可覆盖、不可删除；
 * 目录里占用内置 id 的文件会被忽略。返回的角色都是副本，修改不影响仓库。
 *
 * `list` 只在角色目录本身读不了（非 ENOENT）时 reject；`get` / `save` / `remove` 从不 reject。
 */
export class JsonFileRoleStore implements RoleStore {
  readonly #fs: CoreFs;
  readonly #dir: string;
  readonly #onInvalidFile: (file: string, error: string) => void;

  /** @param options - 注入的文件系统、角色目录与无效文件回调。 */
  constructor(options: JsonFileRoleStoreOptions) {
    this.#fs = options.fs;
    this.#dir = options.dir;
    this.#onInvalidFile = options.onInvalidFile ?? (() => undefined);
  }

  async list(): Promise<Role[]> {
    const files = (await this.#readDir()).filter((file) => file.endsWith(SUFFIX)).sort();
    const custom: Role[] = [];
    for (const file of files) {
      const role = await this.#readCustom(file.slice(0, -SUFFIX.length));
      if (role) custom.push(role);
    }
    return [...BUILTIN_ROLES.map((role) => structuredClone(role)), ...custom];
  }

  async get(id: string): Promise<Role | undefined> {
    if (isBuiltinRoleId(id)) return getBuiltinRole(id);
    return isValidRoleId(id) ? this.#readCustom(id) : undefined;
  }

  async save(role: Role): Promise<SaveRoleResult> {
    const parsed = parseRole(role);
    if (!parsed.ok) return parsed;
    const { id } = parsed.role;
    if (isBuiltinRoleId(id)) {
      return { ok: false, error: `built-in role "${id}" cannot be overwritten` };
    }
    const custom = withoutBuiltinFlag(parsed.role);
    try {
      await this.#fs.mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#fs, this.#pathOf(id), `${JSON.stringify(custom, null, 2)}\n`);
    } catch (error) {
      return { ok: false, error: `failed to save role "${id}": ${errorMessage(error)}` };
    }
    return { ok: true, role: custom };
  }

  async remove(id: string): Promise<RemoveRoleResult> {
    if (isBuiltinRoleId(id)) return { ok: false, error: `built-in role "${id}" cannot be removed` };
    if (!isValidRoleId(id)) return { ok: false, error: `invalid role id: ${JSON.stringify(id)}` };
    try {
      await this.#fs.unlink(this.#pathOf(id));
    } catch (error) {
      return {
        ok: false,
        error: isNotFoundError(error)
          ? `role "${id}" not found`
          : `failed to remove role "${id}": ${errorMessage(error)}`,
      };
    }
    return { ok: true };
  }

  #pathOf(id: string): string {
    return joinPath(this.#dir, `${id}${SUFFIX}`);
  }

  async #readDir(): Promise<string[]> {
    try {
      return await this.#fs.readdir(this.#dir);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  /** 读 `<id>.json`；不存在返回 `undefined`，无效时报告并返回 `undefined`。 */
  async #readCustom(id: string): Promise<Role | undefined> {
    const file = `${id}${SUFFIX}`;
    const invalid = (error: string): undefined => {
      this.#onInvalidFile(file, error);
      return undefined;
    };
    if (!isValidRoleId(id)) return invalid('file name is not a valid role id');
    if (isBuiltinRoleId(id)) {
      return invalid(`"${id}" is a built-in role id and cannot be redefined`);
    }

    let text: string;
    try {
      text = await this.#fs.readFile(this.#pathOf(id), 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      return invalid(`cannot read file: ${errorMessage(error)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return invalid(`invalid JSON: ${errorMessage(error)}`);
    }
    const parsed = parseRole(data);
    if (!parsed.ok) return invalid(parsed.error);
    if (parsed.role.id !== id) {
      return invalid(`role.id "${parsed.role.id}" does not match the file name`);
    }
    return withoutBuiltinFlag(parsed.role);
  }
}

/** 自定义角色永远不是内置角色：丢掉文件或入参里的 `builtin` 标记。 */
function withoutBuiltinFlag(role: Role): Role {
  const { builtin: _builtin, ...custom } = role;
  return custom;
}
