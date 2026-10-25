import { nextApprovalMode } from '@shared/types/chat';
import { CircleStop, SendHorizontal } from 'lucide-react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { insertNewline, matchAction, useActionHandler, useComposerHints } from '@/lib/keybindings';
import {
  isBusy,
  selectDraftOf,
  selectMessagesOf,
  selectSessionOf,
  selectStatusOf,
  useSessionsStore,
} from '@/stores/sessions';
import { ApprovalModePicker } from './ApprovalModePicker';
import {
  currentText,
  down,
  type InputHistory,
  isBrowsing,
  startHistory,
  toDraft,
  up,
} from './inputHistory';
import { ModelPicker } from './ModelPicker';
import { STATUS_LABEL } from './SessionBadges';

type Caret = 'start' | 'end';

/** 光标（没有选区）在第一行：它前面没有换行 */
function caretOnFirstLine(input: HTMLTextAreaElement): boolean {
  const { selectionStart, selectionEnd, value } = input;
  return selectionStart === selectionEnd && !value.slice(0, selectionStart).includes('\n');
}

/** 光标（没有选区）在最后一行：它后面没有换行 */
function caretOnLastLine(input: HTMLTextAreaElement): boolean {
  const { selectionStart, selectionEnd, value } = input;
  return selectionStart === selectionEnd && !value.slice(selectionEnd).includes('\n');
}

/**
 * 输入框：多行，Enter 发送、Shift+Enter 换行；运行中显示「停止」。草稿按会话存在 store。
 * 左下角是模型胶囊与审批胶囊；Shift+Tab 循环切换审批档位。
 * ↑ / ↓ 像终端一样翻这个会话发过的消息：输入框为空或光标在第一行时 ↑ 取上一条，
 * 在最后一行时 ↓ 取下一条，翻过最新一条回到草稿；Esc 直接回到草稿；翻到的内容一经编辑就成为新的草稿。
 * 这些都是默认键：按键经动作表（设置 → 快捷键）判断，另有运行中 Esc 停止、Ctrl+M（macOS ⌘M）打开模型选择器。
 */
export function Composer({ sessionId }: { sessionId: string }) {
  const draft = useSessionsStore(selectDraftOf(sessionId));
  const status = useSessionsStore(selectStatusOf(sessionId));
  const approvalMode = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.approvalMode);
  const messages = useSessionsStore(selectMessagesOf(sessionId));
  const setDraft = useSessionsStore((state) => state.setDraft);
  const send = useSessionsStore((state) => state.send);
  const abort = useSessionsStore((state) => state.abort);
  const setApprovalMode = useSessionsStore((state) => state.setApprovalMode);
  const openModelPicker = useSessionsStore((state) => state.openModelPicker);
  const hints = useComposerHints();
  const input = useRef<HTMLTextAreaElement>(null);
  useActionHandler('focus-composer', () => input.current?.focus());
  /** 正在翻的历史；null 表示没在浏览（输入框里是草稿） */
  const history = useRef<InputHistory | null>(null);
  /** 翻到新内容后光标放哪：↑ 放开头（接着按 ↑ 继续往前翻），↓ 放末尾 */
  const pendingCaret = useRef<Caret | null>(null);

  // 历史来源：这个会话里 user 的消息，含 history 回放的与这次发出去的（都在 store 的时间线里）
  const sent = useMemo(
    () => messages.filter((message) => message.role === 'user').map((message) => message.text),
    [messages]
  );

  const busy = isBusy(status);
  const canSend = !busy && draft.trim().length > 0;
  const submit = () => {
    if (!canSend) return;
    history.current = null;
    void send(draft);
  };

  const placeCaret = (caret: Caret) => {
    const element = input.current;
    if (!element) return;
    const position = caret === 'start' ? 0 : element.value.length;
    element.setSelectionRange(position, position);
  };

  /** 换成历史里的另一条（或回到草稿） */
  const browse = (next: InputHistory, caret: Caret) => {
    history.current = isBrowsing(next) ? next : null;
    const text = currentText(next);
    if (text === draft) {
      placeCaret(caret);
      return;
    }
    pendingCaret.current = caret;
    setDraft(sessionId, text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字时的按键（Enter 确认候选词、方向键选词）都交给输入法
    if (event.nativeEvent.isComposing) return;
    const textarea = event.currentTarget;
    if (matchAction(event, 'cycle-approval')) {
      event.preventDefault();
      if (approvalMode) void setApprovalMode(sessionId, nextApprovalMode(approvalMode));
      return;
    }
    if (matchAction(event, 'history-prev') && caretOnFirstLine(textarea)) {
      const state = history.current ?? startHistory(sent, draft);
      const next = up(state);
      if (next === state) return;
      event.preventDefault();
      browse(next, 'start');
      return;
    }
    if (matchAction(event, 'history-next') && history.current) {
      if (!caretOnLastLine(textarea)) return;
      event.preventDefault();
      browse(down(history.current), 'end');
      return;
    }
    if (event.key === 'Escape' && history.current) {
      event.preventDefault();
      browse(toDraft(history.current), 'end');
      return;
    }
    if (busy && matchAction(event, 'stop-turn')) {
      event.preventDefault();
      void abort();
      return;
    }
    if (matchAction(event, 'open-model-picker')) {
      event.preventDefault();
      openModelPicker(sessionId);
      return;
    }
    if (matchAction(event, 'newline')) {
      insertNewline(event);
      return;
    }
    if (!matchAction(event, 'send')) return;
    event.preventDefault();
    submit();
  };

  // 受控的 value 换了之后光标会落到末尾：渲染出翻到的内容后，按翻的方向重新放（只是读一个 ref，每次渲染都查）
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (!caret) return;
    pendingCaret.current = null;
    placeCaret(caret);
  });

  // 切到这个会话时把焦点放进输入框（不用 autoFocus：a11y 规则禁止）
  useEffect(() => {
    input.current?.focus();
  }, []);

  // 离开这个会话时还在翻历史：放弃浏览，把原来的草稿放回去（同 Esc）
  useEffect(
    () => () => {
      const browsing = history.current;
      if (browsing) setDraft(sessionId, browsing.draft);
    },
    [sessionId, setDraft]
  );

  return (
    <div className="shrink-0 px-4 pb-3">
      <div className="mx-auto max-w-3xl rounded-xl border bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
        <Textarea
          ref={input}
          value={draft}
          rows={1}
          aria-label="消息"
          aria-keyshortcuts={hints.ariaKeyShortcuts}
          title={hints.title}
          placeholder="输入消息"
          className="field-sizing-content max-h-60 min-h-11 resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(event) => {
            // 翻到的内容一经编辑就成为新的草稿，不再处于浏览状态
            history.current = null;
            setDraft(sessionId, event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <ModelPicker sessionId={sessionId} />
            <ApprovalModePicker sessionId={sessionId} />
            {busy && (
              <span className="shrink-0 text-muted-foreground text-xs">{STATUS_LABEL[status]}</span>
            )}
          </div>
          {busy ? (
            <Button size="sm" variant="secondary" onClick={() => void abort()}>
              <CircleStop />
              停止
            </Button>
          ) : (
            <Button size="sm" disabled={!canSend} onClick={submit}>
              <SendHorizontal />
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
