/**
 * 工具参数归一化（在 pi 的 schema 校验之前，经 `prepareArguments` 执行）。
 *
 * 只做安全的形状修正：别名、trim、数字字符串、单值转数组、默认值、clamp。
 * 类型不对的值原样返回，交给 schema 校验给出准确报错；所有函数都不抛异常。
 */

export type ArgRecord = Record<string, unknown>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function asRecord(raw: unknown): ArgRecord {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ArgRecord) : {};
}

/** 取第一个有值的键：snake_case 正名在前，camelCase 等别名在后 */
export function pick(args: ArgRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function trimmed(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** 数字或数字字符串 → 整数；其余原样返回 */
export function integerish(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : value;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return Math.round(Number(value));
  }
  return value;
}

/** 单个字符串（按 separator 拆分）或字符串数组 → 去空、去重后的字符串数组 */
export function stringList(value: unknown, separator: RegExp = /[\n,]/): unknown {
  const items = typeof value === 'string' ? value.split(separator) : value;
  if (!Array.isArray(items) || !items.every((item) => typeof item === 'string')) return value;
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 去掉值为 undefined 的键，使对象满足 `additionalProperties: false` 的 schema */
export function compact(args: ArgRecord): ArgRecord {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

/** 必填非空字符串 */
export function requiredText(value: unknown, name: string): Parsed<string> {
  if (value === undefined || value === null) return { ok: false, error: `${name} is required` };
  if (typeof value !== 'string') return { ok: false, error: `${name} must be a string` };
  const text = value.trim();
  return text ? { ok: true, value: text } : { ok: false, error: `${name} is required` };
}
