import type { AppMessageBoxType } from '@shared/types/appDialog';
import { create } from 'zustand';
import { translate } from '../i18n';

/** 队列里的一个提示框；文字只按纯文本渲染。 */
export interface AppDialogEntry {
  id: number;
  type: AppMessageBoxType;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  destructiveId?: number;
}

interface Queued extends AppDialogEntry {
  resolve(response: number): void;
}

/** 依次显示：队首就是当前显示的那个。 */
export const useAppDialogStore = create<{ queue: Queued[] }>(() => ({ queue: [] }));

let nextId = 0;

function enqueue(entry: Omit<AppDialogEntry, 'id'>): Promise<number> {
  return new Promise((resolve) => {
    const queued: Queued = { ...entry, id: ++nextId, resolve };
    useAppDialogStore.setState((state) => ({ queue: [...state.queue, queued] }));
  });
}

/** 用户选了某个按钮（Esc / 点遮罩传 cancelId）。同一个提示框只结算一次。 */
export function respondAppDialog(id: number, response: number): void {
  const entry = useAppDialogStore.getState().queue.find((item) => item.id === id);
  if (!entry) return;
  useAppDialogStore.setState((state) => ({ queue: state.queue.filter((item) => item.id !== id) }));
  entry.resolve(
    Number.isInteger(response) && response >= 0 && response < entry.buttons.length
      ? response
      : entry.cancelId
  );
}

function index(value: number | undefined, length: number, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value < length
    ? value
    : fallback;
}

/** 与 `dialog.showMessageBox` 同语义：返回按钮下标，Esc / 点遮罩返回 cancelId。 */
export function messageBox(options: {
  type?: AppMessageBoxType;
  title?: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
  destructiveId?: number;
}): Promise<number> {
  const buttons = options.buttons.length > 0 ? options.buttons : [translate('common.confirm')];
  const destructiveId =
    options.destructiveId === undefined
      ? undefined
      : index(options.destructiveId, buttons.length, -1);
  return enqueue({
    type: options.type ?? 'none',
    title: options.title ?? '',
    message: options.message,
    detail: options.detail ?? '',
    buttons,
    defaultId: index(options.defaultId, buttons.length, 0),
    cancelId: index(options.cancelId, buttons.length, 0),
    ...(destructiveId === undefined || destructiveId < 0 ? {} : { destructiveId }),
  });
}

/** 应用内确认框（替代浏览器原生确认框）。危险操作时默认焦点落在取消上。 */
export async function confirmDialog(options: {
  title?: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  const destructive = options.destructive === true;
  const response = await messageBox({
    type: destructive ? 'warning' : 'question',
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: [
      options.cancelLabel ?? translate('common.cancel'),
      options.confirmLabel ?? translate('common.confirm'),
    ],
    defaultId: destructive ? 0 : 1,
    cancelId: 0,
    ...(destructive ? { destructiveId: 1 } : {}),
  });
  return response === 1;
}

/** 接收 Main 发来的提示框请求：先 ack（过期则不显示），用户选完再回复。返回取消订阅。 */
export function bindMainMessageBoxes(): () => void {
  const api = window.fynvra.appDialog;
  return api.onRequest((request) => {
    void (async () => {
      let accepted = false;
      try {
        accepted = (await api.shown(request.requestId)).ok;
      } catch {
        accepted = false;
      }
      if (!accepted) return;
      const response = await messageBox(request);
      try {
        await api.respond({ requestId: request.requestId, response });
      } catch {
        /* 窗口正在关闭；Main 会按取消处理。 */
      }
    })();
  });
}
