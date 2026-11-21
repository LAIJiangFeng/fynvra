// Fynvra 插件设置页的本地输入状态（纯函数）：字段显示值、提交时机、收集同一行 / 同一 section 的本地输入。
import type { UiField, UiFieldValue, UiNode } from '@shared/types/appPluginUi';

/** 用户正在编辑的值：number 编辑时是字符串；base 记下编辑开始时插件给的值 */
export interface Draft {
  base: UiFieldValue | undefined;
  value: string | boolean;
}
export type Drafts = Readonly<Record<string, Draft>>;

/** 草稿的键：容器 scope + 字段 id */
export const draftKey = (scope: string, fieldId: string) => `${scope}#${fieldId}`;

/** 插件给的值在控件里的样子；密码框不回显 */
export function displayValue(field: UiField): string | boolean {
  switch (field.kind) {
    case 'toggle':
      return field.value === true;
    case 'password':
      return '';
    case 'number':
      return typeof field.value === 'number' ? String(field.value) : '';
    case 'select':
      return typeof field.value === 'string' ? field.value : (field.options?.[0]?.value ?? '');
    default:
      return typeof field.value === 'string' ? field.value : '';
  }
}

/** 控件当前值：插件没改过这个字段时用草稿，改过就以插件的新值为准 */
export function currentValue(field: UiField, draft: Draft | undefined): string | boolean {
  return draft && draft.base === field.value ? draft.value : displayValue(field);
}

/** 发给插件的值；number 非法或越界、密码框没输入过时为 undefined（不发） */
export function wireValue(field: UiField, draft: Draft | undefined): UiFieldValue | undefined {
  if (field.kind === 'password' && !(draft && draft.base === field.value)) return undefined;
  const value = currentValue(field, draft);
  if (field.kind === 'toggle') return value === true;
  if (field.kind !== 'number') return String(value);
  const text = String(value).trim();
  const parsed = Number(text);
  if (!text || !Number.isFinite(parsed)) return undefined;
  if (field.min !== undefined && parsed < field.min) return undefined;
  if (field.max !== undefined && parsed > field.max) return undefined;
  return parsed;
}

/** toggle / select 改动立即提交；text / password / number 失焦或回车提交 */
export function commitOn(field: UiField): 'change' | 'blur' {
  return field.kind === 'toggle' || field.kind === 'select' ? 'change' : 'blur';
}

/** 失焦 / 回车时是否提交：值合法且与插件给的值不同（密码框只要输入了非空值） */
export function shouldCommit(field: UiField, draft: Draft | undefined): boolean {
  if (!field.action) return false;
  const value = wireValue(field, draft);
  if (value === undefined) return false;
  if (field.kind === 'password') return value !== '';
  return value !== field.value && !(field.value === undefined && value === '');
}

/** 同一容器里不带 action 的字段的值，随按钮或带 action 的字段一起发出 */
export function collectValues(
  siblings: readonly UiNode[],
  scope: string,
  drafts: Drafts
): Record<string, UiFieldValue> {
  const values: Record<string, UiFieldValue> = {};
  for (const node of siblings) {
    if (node.type !== 'field' || node.action) continue;
    const value = wireValue(node, drafts[draftKey(scope, node.id)]);
    if (value !== undefined) values[node.id] = value;
  }
  return values;
}

/** 某容器的草稿全部丢掉（操作成功后，以插件重新 render 的值为准） */
export function dropScope(drafts: Drafts, scope: string): Record<string, Draft> {
  const prefix = `${scope}#`;
  return Object.fromEntries(Object.entries(drafts).filter(([key]) => !key.startsWith(prefix)));
}
