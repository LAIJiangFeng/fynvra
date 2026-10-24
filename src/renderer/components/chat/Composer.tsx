import { CircleStop, SendHorizontal } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { isBusy, selectDraftOf, selectStatusOf, useSessionsStore } from '@/stores/sessions';
import { STATUS_LABEL } from './SessionBadges';

/** 输入框：多行，Enter 发送、Shift+Enter 换行；运行中显示「停止」。草稿按会话存在 store。 */
export function Composer({ sessionId }: { sessionId: string }) {
  const draft = useSessionsStore(selectDraftOf(sessionId));
  const status = useSessionsStore(selectStatusOf(sessionId));
  const setDraft = useSessionsStore((state) => state.setDraft);
  const send = useSessionsStore((state) => state.send);
  const abort = useSessionsStore((state) => state.abort);
  const input = useRef<HTMLTextAreaElement>(null);

  const busy = isBusy(status);
  const canSend = !busy && draft.trim().length > 0;
  const submit = () => {
    if (canSend) void send(draft);
  };

  // 切到这个会话时把焦点放进输入框（不用 autoFocus：a11y 规则禁止）
  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <div className="shrink-0 px-4 pb-3">
      <div className="mx-auto max-w-3xl rounded-xl border bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
        <Textarea
          ref={input}
          value={draft}
          rows={1}
          aria-label="消息"
          placeholder={
            busy ? 'agent 正在运行，可以先写下一条…' : '输入消息，Enter 发送，Shift+Enter 换行'
          }
          className="field-sizing-content max-h-60 min-h-11 resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(event) => setDraft(sessionId, event.target.value)}
          onKeyDown={(event) => {
            // 输入法组字时的 Enter 是确认候选词，不是发送
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <span className="pl-2 text-muted-foreground text-xs">{busy && STATUS_LABEL[status]}</span>
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
