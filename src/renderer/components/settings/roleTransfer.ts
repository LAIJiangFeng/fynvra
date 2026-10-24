import { parseRole, type Role } from '@fynvra/core';

// 角色的新建 / 复制 / 导入 / 导出（纯逻辑，可在 node 下测试）。
// 导入导出在 Renderer 完成：读文件用 <input type="file">，写文件走浏览器下载，路径不经过 IPC。

const MAX_ID_LENGTH = 64;

/** 名称 → 角色 id 候选（core 的 slug 规则）：小写，非字母数字的连续字符折叠为 `-`。 */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
}

function uniqueRoleId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** 按名称建议一个未被占用的 id；纯中文等规整为空时用 `role`。 */
export function suggestRoleId(name: string, taken: Iterable<string>): string {
  return uniqueRoleId(toSlug(name) || 'role', taken);
}

export function newRole(taken: Iterable<string>): Role {
  return {
    id: suggestRoleId('', taken),
    name: '新角色',
    skillIds: [],
    mcpServerIds: [],
    tools: 'all',
    approvalMode: 'auto-edits',
  };
}

/** 复制为新角色：内置角色也能复制，副本是普通的自定义角色。 */
export function copyRole(role: Role, taken: Iterable<string>): Role {
  const { builtin: _builtin, ...rest } = structuredClone(role);
  return {
    ...rest,
    id: uniqueRoleId(toSlug(`${role.id}-copy`), taken),
    name: `${role.name} 副本`,
  };
}

/** 导出格式与 userData/roles/<id>.json 相同，也可以直接放进角色目录。 */
export function roleToJson(role: Role): string {
  const { builtin: _builtin, ...custom } = role;
  return `${JSON.stringify(custom, null, 2)}\n`;
}

/**
 * 解析导入的 JSON：单个角色或角色数组，逐个经 parseRole 校验（任何一个无效则整体拒绝）。
 * id 与已有角色（含内置）或本批更早的角色冲突时自动加后缀，`renamed` 记录改了几个。
 */
export function parseRoleImport(
  text: string,
  taken: Iterable<string>
): { ok: true; roles: Role[]; renamed: number } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是合法的 JSON' };
  }
  const items: unknown[] = Array.isArray(data) ? data : [data];
  if (items.length === 0) return { ok: false, error: '文件里没有角色' };

  const used = new Set(taken);
  const roles: Role[] = [];
  let renamed = 0;
  for (const [index, item] of items.entries()) {
    const parsed = parseRole(item);
    if (!parsed.ok) {
      const which = items.length > 1 ? `第 ${index + 1} 个角色` : '角色';
      return { ok: false, error: `${which}无效：${parsed.error}` };
    }
    const { builtin: _builtin, ...role } = parsed.role;
    const id = uniqueRoleId(role.id, used);
    if (id !== role.id) renamed += 1;
    used.add(id);
    roles.push({ ...role, id });
  }
  return { ok: true, roles, renamed };
}
