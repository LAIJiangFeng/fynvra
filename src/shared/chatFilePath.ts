/**
 * 聊天本地文件链接的解析规则。Renderer（点击前的匹配）与 Main（files:open-outside 重新校验）共用，
 * 纯函数，不依赖 Node / Electron。
 */
export type ChatPathError = 'invalidLink' | 'unsupportedParameters';
export type ChatPathResult = { ok: true; path: string } | { ok: false; error: ChatPathError };

export const hasControl = (text: string) =>
  Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** 不支持网页 query/hash；编码过的 %23 / %3F 仍是文件名，不是展示参数。结果统一为 `/` 分隔。 */
export function parseChatFilePath(reference: string): ChatPathResult {
  const fail = (error: ChatPathError): ChatPathResult => ({ ok: false, error });
  if (
    !reference ||
    reference.length > 4096 ||
    reference.trim() !== reference ||
    hasControl(reference) ||
    reference.startsWith('#')
  )
    return fail('invalidLink');
  if (/[?#]/.test(reference)) return fail('unsupportedParameters');
  let path = reference;
  const fileUrl = /^file:/i.test(path);
  if (fileUrl) {
    try {
      const url = new URL(path);
      if (
        url.protocol !== 'file:' ||
        (url.hostname && url.hostname !== 'localhost') ||
        url.username ||
        url.password ||
        url.port
      )
        return fail('invalidLink');
      path = url.pathname;
    } catch {
      return fail('invalidLink');
    }
  }
  try {
    path = decodeURIComponent(path).replace(/\\/g, '/');
    if (fileUrl) path = path.replace(/^\/(?=[a-z]:\/)/i, '');
  } catch {
    return fail('invalidLink');
  }
  // 带扩展名的 path:line 可以与 URI 区分；未知协议绝不退化成文件名。
  if (
    /^[a-z][a-z\d+.-]*:/i.test(path) &&
    !/^[a-z]:\//i.test(path) &&
    !/^[^:]+\.[^:]+:\d+(?::\d+)?$/.test(path)
  )
    return fail('invalidLink');
  // 定位仅用于显示；打开文件不改变现有编辑器的光标/草稿。
  path = path.replace(/:\d+(?::\d+)?$/, '');
  const withoutDrive = path.replace(/^[a-z]:\//i, '');
  if (
    !path ||
    hasControl(path) ||
    path.startsWith('//') ||
    withoutDrive.includes(':') ||
    path.startsWith('~')
  )
    return fail('invalidLink');
  return { ok: true, path };
}

/** 已解析路径是否为绝对路径：Windows 盘符路径或 POSIX `/` 路径（UNC `//` 不算）。 */
export function isAbsoluteChatPath(path: string): boolean {
  return /^[a-z]:\//i.test(path) || /^\/(?!\/)/.test(path);
}

/** 展示 / 复制用的本机写法：盘符路径换回反斜杠。 */
export function nativeChatPath(path: string): string {
  return /^[a-z]:\//i.test(path) ? path.replace(/\//g, '\\') : path;
}
