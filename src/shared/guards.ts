/** 普通对象（非 null、非数组）才返回记录视图，供 `unknown` 入参逐字段收窄。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
