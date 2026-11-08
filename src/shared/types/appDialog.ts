/**
 * Main 发起、由 Renderer 用应用内对话框显示的提示框。
 * 语义与 Electron `dialog.showMessageBox` 一致：按钮按下标返回，Esc / 点遮罩返回 `cancelId`。
 */
export type AppMessageBoxType = 'none' | 'info' | 'error' | 'question' | 'warning';

/** Main → Renderer 的请求；字符串都由 Main 提供，Renderer 只当纯文本显示。 */
export interface AppMessageBoxRequest {
  requestId: string;
  type: AppMessageBoxType;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /** 危险操作按钮的下标（用 destructive 样式），没有时省略 */
  destructiveId?: number;
}

/** Renderer → Main：用户选了哪个按钮。越界或非整数时 Main 按 `cancelId` 处理。 */
export interface AppMessageBoxReply {
  requestId: string;
  response: number;
}

const TYPES: readonly AppMessageBoxType[] = ['none', 'info', 'error', 'question', 'warning'];
const MAX_BUTTONS = 8;
const MAX_TEXT = 8_000;

function isIndex(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length;
}

/** 收窄 Main 发来的请求；不合法时返回 null（Main 收不到 ack 会回退到原生对话框）。 */
export function parseAppMessageBoxRequest(raw: unknown): AppMessageBoxRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const { requestId, type, title, message, detail, buttons, defaultId, cancelId, destructiveId } =
    input;
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > 100 ||
    !TYPES.includes(type as AppMessageBoxType) ||
    typeof title !== 'string' ||
    typeof message !== 'string' ||
    typeof detail !== 'string' ||
    !Array.isArray(buttons) ||
    buttons.length === 0 ||
    buttons.length > MAX_BUTTONS ||
    !buttons.every((label) => typeof label === 'string' && label.length <= 200) ||
    !isIndex(defaultId, buttons.length) ||
    !isIndex(cancelId, buttons.length) ||
    (destructiveId !== undefined && !isIndex(destructiveId, buttons.length))
  )
    return null;
  return {
    requestId,
    type: type as AppMessageBoxType,
    title: title.slice(0, MAX_TEXT),
    message: message.slice(0, MAX_TEXT),
    detail: detail.slice(0, MAX_TEXT),
    buttons: [...(buttons as string[])],
    defaultId,
    cancelId,
    ...(destructiveId === undefined ? {} : { destructiveId }),
  };
}
