// Fynvra 插件的声明式设置页：UI 描述 v1（ARCHITECTURE §7.12「Fynvra 插件」）。
// 插件调 `ui.render(schema)`，Main 用 parsePluginUi 校验后交给 Renderer 用 Fynvra 自己的组件渲染。
// 本文件只放类型和纯函数，不得 import Node / Electron。
import { asRecord } from '../guards';
import { isMarketPluginId } from './pluginMarket';

export const MAX_UI_BYTES = 256 * 1024;
export const MAX_UI_DEPTH = 6;
export const MAX_UI_LIST_ITEMS = 200;
/** 非 list 的数组（children、keyValue、options、badges、controls、values）的上限 */
const MAX_ARRAY = 200;

export type UiTone = 'muted' | 'error' | 'warning' | 'success';
export type UiFieldKind = 'text' | 'password' | 'number' | 'toggle' | 'select';
export type UiFieldValue = string | number | boolean;

export interface UiSection {
  type: 'section';
  title: string;
  children: UiNode[];
}
export interface UiText {
  type: 'text';
  text: string;
  tone?: UiTone;
}
export interface UiKeyValue {
  type: 'keyValue';
  items: { label: string; value: string }[];
}
export interface UiField {
  type: 'field';
  id: string;
  label: string;
  kind: UiFieldKind;
  value?: UiFieldValue;
  placeholder?: string;
  /** 仅 select，且 select 必填 */
  options?: { value: string; label: string }[];
  /** 仅 number */
  min?: number;
  max?: number;
  /** 有 action 时改动即提交；没有时只是本地输入，随同一行 / 同一 section 的按钮一起发出 */
  action?: string;
}
export interface UiButton {
  type: 'button';
  label: string;
  action: string;
  tone?: 'default' | 'destructive';
  /** 有值时先弹确认框，内容即确认文案 */
  confirm?: string;
}
export interface UiListItem {
  key: string;
  title: string;
  subtitle?: string;
  badges?: { text: string; tone?: UiTone }[];
  body?: string;
  /** 只接受 https */
  link?: { label: string; url: string };
  controls?: (UiField | UiButton)[];
}
export interface UiList {
  type: 'list';
  empty?: string;
  items: UiListItem[];
}
export type UiNode = UiSection | UiText | UiKeyValue | UiField | UiButton | UiList;

/** `ui.render` 的入参：一份完整的设置页 */
export interface PluginUi {
  children: UiNode[];
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TONES: readonly UiTone[] = ['muted', 'error', 'warning', 'success'];
const KINDS: readonly UiFieldKind[] = ['text', 'password', 'number', 'toggle', 'select'];

/** id、action、key 的格式 */
export function isUiId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** 只接受 https，返回规范化后的地址 */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

class Invalid extends Error {}
const fail = (): never => {
  throw new Invalid();
};

/** 对象且只含给定键 */
function obj(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record || !Object.keys(record).every((key) => keys.includes(key))) fail();
  return record as Record<string, unknown>;
}
function str(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) fail();
  return value as string;
}
function optStr(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : str(value, max);
}
function id(value: unknown): string {
  if (!isUiId(value)) fail();
  return value as string;
}
function arr(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value as unknown[];
}
function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail();
  return value as number;
}
function tone(value: unknown): UiTone | undefined {
  if (value === undefined) return undefined;
  if (!TONES.includes(value as UiTone)) fail();
  return value as UiTone;
}
/** 去掉值为 undefined 的键，结果里只留出现过的可选字段 */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function field(r: Record<string, unknown>): UiField {
  const kind = r.kind as UiFieldKind;
  if (!KINDS.includes(kind)) fail();
  let value: UiFieldValue | undefined;
  if (r.value !== undefined) {
    if (kind === 'number') value = num(r.value);
    else if (kind === 'toggle') {
      if (typeof r.value !== 'boolean') fail();
      value = r.value as boolean;
    } else value = str(r.value, 4000);
  }
  let options: UiField['options'];
  if (kind === 'select') {
    options = arr(r.options, MAX_ARRAY).map((raw) => {
      const option = obj(raw, ['value', 'label']);
      return { value: str(option.value, 200), label: str(option.label, 200) };
    });
    if (options.length === 0) fail();
  } else if (r.options !== undefined) fail();
  if (kind !== 'number' && (r.min !== undefined || r.max !== undefined)) fail();
  const min = r.min === undefined ? undefined : num(r.min);
  const max = r.max === undefined ? undefined : num(r.max);
  if (min !== undefined && max !== undefined && min > max) fail();
  return compact({
    type: 'field' as const,
    id: id(r.id),
    label: str(r.label, 200),
    kind,
    value,
    placeholder: optStr(r.placeholder, 200),
    options,
    min,
    max,
    action: r.action === undefined ? undefined : id(r.action),
  });
}

function button(r: Record<string, unknown>): UiButton {
  if (r.tone !== undefined && r.tone !== 'default' && r.tone !== 'destructive') fail();
  return compact({
    type: 'button' as const,
    label: str(r.label, 200),
    action: id(r.action),
    tone: r.tone as UiButton['tone'],
    confirm: optStr(r.confirm, 500),
  });
}

const FIELD_KEYS = [
  'type',
  'id',
  'label',
  'kind',
  'value',
  'placeholder',
  'options',
  'min',
  'max',
  'action',
];
const BUTTON_KEYS = ['type', 'label', 'action', 'tone', 'confirm'];

/** depth：本节点所在层（顶层为 1） */
function node(raw: unknown, depth: number): UiNode {
  if (depth > MAX_UI_DEPTH) fail();
  const type = asRecord(raw)?.type;
  switch (type) {
    case 'section': {
      const r = obj(raw, ['type', 'title', 'children']);
      return {
        type,
        title: str(r.title, 200),
        children: arr(r.children, MAX_ARRAY).map((child) => node(child, depth + 1)),
      };
    }
    case 'text': {
      const r = obj(raw, ['type', 'text', 'tone']);
      return compact({ type, text: str(r.text, 4000), tone: tone(r.tone) });
    }
    case 'keyValue': {
      const r = obj(raw, ['type', 'items']);
      return {
        type,
        items: arr(r.items, MAX_ARRAY).map((item) => {
          const pair = obj(item, ['label', 'value']);
          return { label: str(pair.label, 200), value: str(pair.value, 1000) };
        }),
      };
    }
    case 'field':
      return field(obj(raw, FIELD_KEYS));
    case 'button':
      return button(obj(raw, BUTTON_KEYS));
    case 'list': {
      const r = obj(raw, ['type', 'empty', 'items']);
      const keys = new Set<string>();
      const items = arr(r.items, MAX_UI_LIST_ITEMS).map((rawItem) =>
        listItem(rawItem, depth, keys)
      );
      return compact({ type, empty: optStr(r.empty, 500), items });
    }
    default:
      return fail();
  }
}

function listItem(raw: unknown, depth: number, keys: Set<string>): UiListItem {
  const r = obj(raw, ['key', 'title', 'subtitle', 'badges', 'body', 'link', 'controls']);
  const key = id(r.key);
  if (keys.has(key)) fail();
  keys.add(key);
  let link: UiListItem['link'];
  if (r.link !== undefined) {
    const l = obj(r.link, ['label', 'url']);
    const url = httpsUrl(l.url);
    if (!url) fail();
    link = { label: str(l.label, 200), url: url as string };
  }
  // 列表项里的控件比列表深一层
  if (r.controls !== undefined && depth + 1 > MAX_UI_DEPTH) fail();
  return compact({
    key,
    title: str(r.title, 200),
    subtitle: optStr(r.subtitle, 500),
    badges:
      r.badges === undefined
        ? undefined
        : arr(r.badges, 20).map((rawBadge) => {
            const badge = obj(rawBadge, ['text', 'tone']);
            return compact({ text: str(badge.text, 50), tone: tone(badge.tone) });
          }),
    body: optStr(r.body, 4000),
    link,
    controls:
      r.controls === undefined
        ? undefined
        : arr(r.controls, MAX_ARRAY).map((control) => {
            const type = asRecord(control)?.type;
            if (type === 'field') return field(obj(control, FIELD_KEYS));
            if (type === 'button') return button(obj(control, BUTTON_KEYS));
            return fail();
          }),
  });
}

/** 序列化后的 UTF-8 字节数；不可序列化时按超限 */
function byteSize(raw: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(raw) ?? '').length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 校验 UI 描述；任何一处不合法整份拒绝（返回 null）。结果是新对象，不含多余键 */
export function parsePluginUi(raw: unknown): PluginUi | null {
  if (byteSize(raw) > MAX_UI_BYTES) return null;
  try {
    const r = obj(raw, ['children']);
    return { children: arr(r.children, MAX_ARRAY).map((child) => node(child, 1)) };
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}

// ---- IPC 入参 ----

export interface UiActionInput {
  id: string;
  action: string;
  itemKey?: string;
  values?: Record<string, UiFieldValue>;
}

/** `{ id, action, itemKey?, values? }`，拒绝多余键 */
export function parseUiActionInput(raw: unknown): UiActionInput | null {
  const record = asRecord(raw);
  if (!record) return null;
  const allowed = ['id', 'action', 'itemKey', 'values'];
  if (!Object.keys(record).every((key) => allowed.includes(key))) return null;
  const { id: pluginId, action, itemKey, values } = record;
  if (!isMarketPluginId(pluginId) || !isUiId(action)) return null;
  if (itemKey !== undefined && !isUiId(itemKey)) return null;
  const result: UiActionInput = { id: pluginId, action };
  if (itemKey !== undefined) result.itemKey = itemKey;
  if (values !== undefined) {
    const map = asRecord(values);
    if (!map) return null;
    const entries = Object.entries(map);
    if (entries.length > MAX_ARRAY) return null;
    for (const [key, value] of entries) {
      if (!isUiId(key)) return null;
      const ok =
        typeof value === 'string'
          ? value.length <= 4000
          : typeof value === 'number'
            ? Number.isFinite(value)
            : typeof value === 'boolean';
      if (!ok) return null;
    }
    // fromEntries 定义自有属性，`__proto__` 这类键不会改原型
    result.values = Object.fromEntries(entries) as Record<string, UiFieldValue>;
  }
  return result;
}

/** `{ id, url }`，url 只接受 https */
export function parseOpenLinkInput(raw: unknown): { id: string; url: string } | null {
  const record = asRecord(raw);
  if (!record || !Object.keys(record).every((key) => key === 'id' || key === 'url')) return null;
  const url = httpsUrl(record.url);
  return isMarketPluginId(record.id) && url ? { id: record.id, url } : null;
}

/** 插件 `ui.action` 处理结果：返回 `{ ok: false, error }` 视为失败，其余（含无返回值）视为成功 */
export type UiActionResult = { ok: true } | { ok: false; error: string };
export function normalizeUiActionResult(raw: unknown): UiActionResult {
  const record = asRecord(raw);
  if (record?.ok === false) {
    return { ok: false, error: String(record.error ?? 'error').slice(0, 1000) };
  }
  return { ok: true };
}
