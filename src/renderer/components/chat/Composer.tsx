import {
  type ChatImage,
  type ChatImageMimeType,
  isChatImageMimeType,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
  nextApprovalMode,
} from '@shared/types/chat';
import { CircleStop, ImagePlus, ListPlus, SendHorizontal, Undo2, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import {
  insertNewline,
  matchAction,
  useActionHandler,
  useChordLabel,
  useComposerHints,
} from '@/lib/keybindings';
import {
  type ImageRejection,
  isBusy,
  type QueuedMessage,
  selectApprovalsOf,
  selectCompactingOf,
  selectDraftImagesOf,
  selectDraftOf,
  selectMessagesOf,
  selectQueueOf,
  selectRecoveryBlockedOf,
  selectReplySuggestionOf,
  selectSessionOf,
  selectStatusOf,
  useSessionsStore,
} from '@/stores/sessions';
import { ApprovalModePicker } from './ApprovalModePicker';
import { caretOnLineEdge } from './caretLine';
import { ImagePreview } from './ImagePreview';
import {
  currentEntry,
  down,
  type InputHistory,
  isBrowsing,
  startHistory,
  toDraft,
  up,
} from './inputHistory';
import { ModelPicker } from './ModelPicker';
import { ReplySuggestionGhost } from './ReplySuggestionGhost';

type Caret = 'start' | 'end';

/** DOM adapter for the pure boundary check (node tests intentionally have no DOM types). */
function caretOnVisualLineEdge(input: HTMLTextAreaElement, edge: 'first' | 'last'): boolean {
  return caretOnLineEdge(input, edge, (caret, boundary) => {
    const document = input.ownerDocument;
    const view = document.defaultView;
    if (!view || !document.body || !input.clientWidth) return null;
    const computed = view.getComputedStyle(input);
    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    for (const property of [
      'font-family',
      'font-size',
      'font-weight',
      'font-style',
      'font-variant',
      'font-stretch',
      'line-height',
      'letter-spacing',
      'word-spacing',
      'text-transform',
      'text-indent',
      'text-align',
      'tab-size',
      'direction',
      'white-space',
      'overflow-wrap',
      'word-break',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
    ]) {
      mirror.style.setProperty(property, computed.getPropertyValue(property));
    }
    Object.assign(mirror.style, {
      position: 'fixed',
      visibility: 'hidden',
      pointerEvents: 'none',
      top: '0',
      left: '0',
      boxSizing: 'border-box',
      // clientWidth is the padding box, excluding borders and the vertical scrollbar.
      width: `${input.clientWidth}px`,
      whiteSpace: input.wrap === 'off' ? 'pre' : computed.whiteSpace || 'pre-wrap',
    });
    const marker = document.createElement('span');
    const topAt = (position: number) => {
      mirror.textContent = input.value.slice(0, position);
      // Keep the suffix: dropping it changes word wrapping before the caret. A zero-width
      // sentinel gives an empty/trailing-newline row a box without adding a character's width.
      marker.textContent = input.value.slice(position) || '\u200b';
      mirror.append(marker);
      return marker.offsetTop;
    };
    document.body.append(mirror);
    try {
      // Both positions use the same unscrolled mirror, regardless of textarea.scrollTop.
      return { caret: topAt(caret), edge: topAt(boundary) };
    } finally {
      mirror.remove();
    }
  });
}

/** Picker and paste share the same MIME filter and ingestion path. */
function supportedImages(files: File[]) {
  return files.flatMap((file) =>
    isChatImageMimeType(file.type) ? [{ file, mimeType: file.type }] : []
  );
}

/** 输入框操作提示显示多久 */
const COMPOSER_HINT_MS = 5_000;
const MiB = 1024 * 1024;

/** 文件读成 base64（去掉 `data:…;base64,` 前缀）；读不出来时为 null。不缩放、不重编码，交给 pi */
function readBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      resolve(comma < 0 ? null : url.slice(comma + 1));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 图片没加进去时的提示 */
function imageProblem(problem: ImageRejection | 'unsupported', t: T): string {
  switch (problem) {
    case 'count':
      return t('chat.imagesTooMany', { max: MAX_CHAT_IMAGES });
    case 'size':
      return t('chat.imageTooLarge', {
        single: MAX_CHAT_IMAGE_BYTES / MiB,
        total: MAX_CHAT_IMAGES_TOTAL_BYTES / MiB,
      });
    case 'unsupported':
      return t('chat.imageUnsupported');
    case 'invalid':
      return t('chat.imageUnreadable');
  }
}

/**
 * 输入框：多行，Enter 发送、Shift+Enter 换行；运行中显示「停止」。草稿按会话存在 store。
 * 左下角是图片按钮、模型胶囊与审批胶囊；Shift+Tab 循环切换审批档位。
 * ↑ / ↓ 像终端一样翻这个会话发过的消息：输入框为空或光标在视觉第一行时 ↑ 取上一条，
 * 在视觉最后一行时 ↓ 取下一条，翻过最新一条回到草稿；Esc 直接回到草稿；翻到的内容一经编辑就成为新的草稿。
 * 这些都是默认键：按键经动作表（设置 → 快捷键）判断，另有运行中 Esc 停止、Ctrl+M（macOS ⌘M）打开模型选择器。
 * Ctrl/⌘+V 粘贴图片：剪贴板里有 PNG / JPEG / GIF / WebP 文件时以图片为准，缩略图挂在输入框顶部
 * （草稿，按会话存在 store），只有图片也能发；没有图片文件时照常粘贴文字。
 * 一轮正常结束后 store 可能带一条灰字建议：它不进入草稿、不占发送按钮；光标在末尾且没有修饰键时按 → 采纳为草稿，
 * Esc 忽略本轮。普通输入不匹配建议时立即隐藏；运行中、有队列 / 审批 / 图片 / 历史浏览时不显示。
 */
export function Composer({ sessionId }: { sessionId: string }) {
  const draft = useSessionsStore(selectDraftOf(sessionId));
  const images = useSessionsStore(selectDraftImagesOf(sessionId));
  const status = useSessionsStore(selectStatusOf(sessionId));
  const suggestion = useSessionsStore(selectReplySuggestionOf(sessionId));
  const approvals = useSessionsStore(selectApprovalsOf(sessionId));
  const approvalMode = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.approvalMode);
  const messages = useSessionsStore(selectMessagesOf(sessionId));
  const setDraft = useSessionsStore((state) => state.setDraft);
  const setDraftImages = useSessionsStore((state) => state.setDraftImages);
  const send = useSessionsStore((state) => state.send);
  const steer = useSessionsStore((state) => state.steer);
  const removeQueued = useSessionsStore((state) => state.removeQueued);
  const recallQueued = useSessionsStore((state) => state.recallQueued);
  const queue = useSessionsStore(selectQueueOf(sessionId));
  const paused = useSessionsStore((state) => state.pausedQueues[sessionId] === true);
  const compacting = useSessionsStore(selectCompactingOf(sessionId));
  const recoveryBlocked = useSessionsStore(selectRecoveryBlockedOf(sessionId));
  const recovering = useSessionsStore((state) => state.recoveringCompaction[sessionId] === true);
  const stopping = useSessionsStore((state) => state.stopping[sessionId] === true);
  const resumeQueue = useSessionsStore((state) => state.resumeQueue);
  const abort = useSessionsStore((state) => state.abort);
  const setApprovalMode = useSessionsStore((state) => state.setApprovalMode);
  const openModelPicker = useSessionsStore((state) => state.openModelPicker);
  const attachImages = useSessionsStore((state) => state.attachImages);
  const removeDraftImage = useSessionsStore((state) => state.removeDraftImage);
  const ignoreSuggestion = useSessionsStore((state) => state.ignoreSuggestion);
  const hints = useComposerHints();
  const sendLabel = useChordLabel('send');
  const steerLabel = useChordLabel('steer-now');
  const t = useT();
  const input = useRef<HTMLTextAreaElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  /** 输入法组字中：keydown 的 isComposing / keyCode 229 之外再兜一层 composition 状态 */
  const composing = useRef(false);
  /** 正在翻历史：与 history ref 同步，供灰字显隐/光标逻辑读 */
  const [browsing, setBrowsing] = useState(false);
  useActionHandler('focus-composer', () => input.current?.focus());
  /** 正在翻的历史；null 表示没在浏览（输入框里是草稿） */
  const history = useRef<InputHistory | null>(null);
  /** 换内容后的光标位置；撤回编辑还要聚焦，按会话核对以免抢走新会话的焦点 */
  const pendingCaret = useRef<{ sessionId: string; caret: Caret; focus?: boolean } | null>(null);
  /** 图片或撤回操作的提示；每次设成新对象，同样的提示再出现也重新计时 */
  const [composerHint, setComposerHint] = useState<{ text: string } | null>(null);

  // 历史来源：这个会话里 user 的消息，含 history 回放的与这次发出去的（都在 store 的时间线里）
  const sent = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user')
        .map((message) => ({ text: message.text, images: message.images ?? [] })),
    [messages]
  );

  const busy = isBusy(status) || compacting || recovering;
  // 灰字只在空闲、没队列 / 审批 / 图片、没翻历史且草稿恰好是建议前缀时显示；它不进 draft，也不影响 canSend
  const ghostVisible =
    suggestion !== undefined &&
    !busy &&
    status === 'idle' &&
    approvals.length === 0 &&
    queue.length === 0 &&
    images.length === 0 &&
    !browsing &&
    draft.length < suggestion.text.length &&
    suggestion.text.startsWith(draft);
  const ghostSuffix = ghostVisible && suggestion ? suggestion.text.slice(draft.length) : '';
  // While running the message is queued (sent when the turn settles) instead of being refused
  const canSend = draft.trim().length > 0 || images.length > 0;
  const submit = () => {
    if (!canSend) return;
    history.current = null;
    setBrowsing(false);
    void send(draft);
  };
  /** Idle: same as send. Running: steer the latest queued message, or the draft when none is queued */
  const steerNow = () => {
    if (recoveryBlocked) {
      if (queue.length === 0) submit();
      return;
    }
    if (!busy) {
      submit();
      return;
    }
    if (queue.length === 0) {
      history.current = null;
      setBrowsing(false);
    }
    void steer(sessionId);
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
    setBrowsing(history.current !== null);
    const entry = currentEntry(next);
    setDraftImages(sessionId, entry.images);
    if (entry.text === draft) {
      placeCaret(caret);
      return;
    }
    pendingCaret.current = { sessionId, caret };
    setDraft(sessionId, entry.text);
  };

  /** 读出图片加进草稿；格式不支持、太大、超过张数、读不出来的不加，给出提示 */
  const ingestImages = async (
    files: { file: File; mimeType: ChatImageMimeType }[],
    unsupported: boolean
  ) => {
    let problem: ImageRejection | 'unsupported' | undefined = unsupported
      ? 'unsupported'
      : undefined;
    // 明显超过单张上限的不读进内存
    const fitting = files.filter(({ file }) => file.size <= MAX_CHAT_IMAGE_BYTES);
    if (fitting.length < files.length) problem = 'size';
    const read = await Promise.all(
      fitting.map(async ({ file, mimeType }): Promise<ChatImage | null> => {
        const data = await readBase64(file);
        return data ? { data, mimeType } : null;
      })
    );
    const pasted = read.filter((image) => image !== null);
    if (pasted.length < read.length) problem ??= 'invalid';
    const previousImages = useSessionsStore.getState().draftImages[sessionId];
    problem = attachImages(sessionId, pasted) ?? problem;
    const state = useSessionsStore.getState();
    // 只在确实加了图片时结束浏览；读文件期间可能已经切到别的会话。
    if (state.activeSessionId === sessionId && state.draftImages[sessionId] !== previousImages) {
      history.current = null;
      setBrowsing(false);
    }
    setComposerHint(problem ? { text: imageProblem(problem, t) } : null);
  };

  // × 按钮随图片一起消失：焦点放回输入框，不掉到 body 上
  const removeImage = useCallback(
    (index: number) => {
      history.current = null;
      setBrowsing(false);
      removeDraftImage(sessionId, index);
      input.current?.focus();
    },
    [sessionId, removeDraftImage]
  );

  // The row buttons disappear with the row: keep the focus in the input
  const sendQueuedNow = useCallback(
    (id: string) => {
      void steer(sessionId, id);
      input.current?.focus();
    },
    [sessionId, steer]
  );
  const dropQueued = useCallback(
    (id: string) => {
      removeQueued(sessionId, id);
      input.current?.focus();
    },
    [sessionId, removeQueued]
  );

  const recallForEditing = useCallback(
    (id: string) => {
      if (useSessionsStore.getState().activeSessionId !== sessionId) return;
      const result = recallQueued(sessionId, id);
      if (result === 'draft-exists') {
        setComposerHint({ text: t('chat.recallQueuedDraftExists') });
        return;
      }
      if (result !== 'recalled') return;
      history.current = null;
      pendingCaret.current = { sessionId, caret: 'end', focus: true };
      setBrowsing(false);
      setComposerHint(null);
    },
    [sessionId, recallQueued, t]
  );

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    const pasted = supportedImages(files);
    if (pasted.length === 0) {
      // 剪贴板里的图片格式不支持（BMP、SVG 等）：文字照常粘贴，提示一下
      if (files.some((file) => file.type.startsWith('image/'))) {
        setComposerHint({ text: imageProblem('unsupported', t) });
      }
      return;
    }
    // 有图片文件时以图片为准（与 EnsoCode 一致），不再粘贴剪贴板里的文字
    event.preventDefault();
    void ingestImages(pasted, pasted.length < files.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字时的按键（Enter 确认候选词、方向键选词）都交给输入法；
    // 有的浏览器在 compositionend 后仍报 keyCode 229，这里一并挡住
    if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) {
      return;
    }
    const textarea = event.currentTarget;
    // → 只在灰字可见、无修饰键、无选区且光标在末尾时采纳为草稿；不发送、不写历史
    if (
      ghostVisible &&
      suggestion &&
      event.key === 'ArrowRight' &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      textarea.selectionStart === textarea.selectionEnd &&
      textarea.selectionStart === textarea.value.length
    ) {
      event.preventDefault();
      history.current = null;
      setBrowsing(false);
      pendingCaret.current = { sessionId, caret: 'end' };
      // 采纳后与 Esc 一样结束本轮建议：之后删空草稿也不会再冒出来
      ignoreSuggestion(sessionId);
      setDraft(sessionId, suggestion.text);
      return;
    }
    if (matchAction(event, 'cycle-approval')) {
      event.preventDefault();
      if (approvalMode) void setApprovalMode(sessionId, nextApprovalMode(approvalMode));
      return;
    }
    if (matchAction(event, 'history-prev') && caretOnVisualLineEdge(textarea, 'first')) {
      const state = history.current ?? startHistory(sent, { text: draft, images });
      const next = up(state);
      if (next === state) return;
      event.preventDefault();
      browse(next, 'start');
      return;
    }
    if (matchAction(event, 'history-next') && history.current) {
      if (!caretOnVisualLineEdge(textarea, 'last')) return;
      event.preventDefault();
      browse(down(history.current), 'end');
      return;
    }
    if (event.key === 'Escape' && history.current) {
      event.preventDefault();
      browse(toDraft(history.current), 'end');
      return;
    }
    // 灰字建议：Esc 忽略本轮，不重新出现；没有灰字时 Esc 保持原行为
    if (event.key === 'Escape' && ghostVisible) {
      event.preventDefault();
      ignoreSuggestion(sessionId);
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
    if (matchAction(event, 'steer-now')) {
      // Always swallow it (Ctrl+S / Cmd+S), even when there is nothing to send
      event.preventDefault();
      steerNow();
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

  // 受控内容渲染后再放光标；撤回编辑的焦点只归发起操作的当前会话。
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    pendingCaret.current = null;
    if (
      pending.sessionId !== sessionId ||
      useSessionsStore.getState().activeSessionId !== sessionId
    ) {
      return;
    }
    if (pending.focus) input.current?.focus();
    placeCaret(pending.caret);
  });

  // 切到这个会话时把焦点放进输入框（不用 autoFocus：a11y 规则禁止）
  useEffect(() => {
    input.current?.focus();
  }, []);

  // 操作提示过一会儿自己消失
  useEffect(() => {
    if (!composerHint) return;
    const timer = setTimeout(() => setComposerHint(null), COMPOSER_HINT_MS);
    return () => clearTimeout(timer);
  }, [composerHint]);

  // 离开这个会话时还在翻历史：放弃浏览，把原来的草稿放回去（同 Esc）
  useEffect(
    () => () => {
      const browsing = history.current;
      history.current = null;
      setBrowsing(false);
      if (browsing) {
        setDraft(sessionId, browsing.draft.text);
        setDraftImages(sessionId, browsing.draft.images);
      }
    },
    [sessionId, setDraft, setDraftImages]
  );

  return (
    <div className="shrink-0 px-4 pb-3">
      <div className="mx-auto max-w-3xl rounded-xl border bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
        {paused && queue.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-3 pt-3 text-muted-foreground text-xs">
            <span role="status">{t('chat.queuePaused')}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || recoveryBlocked || stopping}
              onClick={() => resumeQueue(sessionId)}
            >
              {t('chat.resumeQueue')}
            </Button>
          </div>
        )}
        <QueuedMessages
          queue={queue}
          steerLabel={steerLabel}
          blocked={recoveryBlocked}
          compacting={compacting}
          onSendNow={sendQueuedNow}
          onRecall={recallForEditing}
          onRemove={dropQueued}
        />
        <DraftImages images={images} onRemove={removeImage} />
        {composerHint && (
          <p role="status" className="px-4 pt-2 text-destructive text-xs">
            {composerHint.text}
          </p>
        )}
        <div className="relative">
          <ReplySuggestionGhost
            textarea={input}
            draft={draft}
            suffix={ghostSuffix}
            visible={ghostVisible}
          />
          <Textarea
            ref={input}
            value={draft}
            rows={1}
            aria-label={t('chat.message')}
            aria-keyshortcuts={hints.ariaKeyShortcuts}
            title={hints.title}
            placeholder={ghostVisible ? '' : t('chat.placeholder')}
            className="field-sizing-content relative z-10 max-h-60 min-h-11 resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => {
              // 翻到的内容一经编辑就成为新的草稿，不再处于浏览状态
              history.current = null;
              setBrowsing(false);
              setDraft(sessionId, event.target.value);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {ghostVisible && suggestion
            ? t('chat.replySuggestionHint', { suggestion: suggestion.text })
            : ''}
        </p>
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <input
              ref={imagePicker}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                if (files.length === 0) return;
                const supported = supportedImages(files);
                void ingestImages(supported, supported.length < files.length);
                input.current?.focus();
              }}
            />
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={t('chat.addImages')}
                onClick={() => imagePicker.current?.click()}
              >
                <ImagePlus />
              </TooltipTrigger>
              <TooltipContent>{t('chat.addImages')}</TooltipContent>
            </Tooltip>
            <ModelPicker sessionId={sessionId} />
            <ApprovalModePicker sessionId={sessionId} />
            {busy && (
              <span className="shrink-0 text-muted-foreground text-xs">
                {t(
                  compacting
                    ? 'chat.compacting'
                    : recovering
                      ? 'chat.compactionRecovering'
                      : `sessions.status.${status}`
                )}
              </span>
            )}
            {busy && (
              <span className="truncate text-muted-foreground text-xs">
                {t(recoveryBlocked ? 'chat.compactionQueueHint' : 'chat.queueHint', {
                  queue: sendLabel,
                  steer: steerLabel,
                })}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {busy && (
              <Button
                size="sm"
                variant="secondary"
                disabled={stopping}
                onClick={() => void abort()}
              >
                <CircleStop />
                {t(stopping ? 'chat.stopping' : 'chat.stop')}
              </Button>
            )}
            {busy || recoveryBlocked ? (
              <Button size="sm" variant="outline" disabled={!canSend} onClick={submit}>
                <ListPlus />
                {t('chat.queue')}
              </Button>
            ) : (
              <Button size="sm" disabled={!canSend} onClick={submit}>
                <SendHorizontal />
                {t('chat.send')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 输入框顶部的缩略图条：64×64，右上角 × 移除。单独 memo：打字时不重画（data URL 可能很长） */
const DraftImages = memo(function DraftImages({
  images,
  onRemove,
}: {
  images: ChatImage[];
  onRemove: (index: number) => void;
}) {
  const t = useT();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {images.map((image, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 草稿图片没有 id，同一张图也可能粘贴两次；移除按位置
        <div key={index} className="relative size-16 shrink-0">
          <button
            type="button"
            aria-label={t('chat.previewImage', { index: index + 1 })}
            onClick={() => setPreviewIndex(index)}
            className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={t('chat.image', { index: index + 1 })}
              className="size-16 rounded-md border object-cover"
            />
          </button>
          <button
            type="button"
            aria-label={t('chat.removeImage', { index: index + 1 })}
            title={t('chat.removeImage', { index: index + 1 })}
            onClick={() => onRemove(index)}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <ImagePreview images={images} index={previewIndex} onIndexChange={setPreviewIndex} />
    </div>
  );
});

/**
 * Messages queued while the session runs, oldest first: text preview, image count, send now (steer),
 * recall to edit and remove. They are not in the timeline until they are actually sent
 */
const QueuedMessages = memo(function QueuedMessages({
  queue,
  steerLabel,
  blocked,
  compacting,
  onSendNow,
  onRecall,
  onRemove,
}: {
  queue: QueuedMessage[];
  steerLabel: string;
  blocked: boolean;
  compacting: boolean;
  onSendNow: (id: string) => void;
  onRecall: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  if (queue.length === 0) return null;
  const buttonClass =
    'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50';
  return (
    <ul className="flex flex-col gap-1 px-3 pt-3">
      {blocked && (
        <li role="status" className="pb-1 text-muted-foreground text-xs">
          {t(compacting ? 'chat.queuedForCompaction' : 'chat.queuedForRecovery')}
        </li>
      )}
      {queue.map((item) => {
        const preview = item.text.trim().split(/\r?\n/)[0] ?? '';
        return (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">
              {preview || (
                <span className="text-muted-foreground">{t('chat.queuedImageOnly')}</span>
              )}
            </span>
            {item.images.length > 0 && (
              <span className="shrink-0 text-muted-foreground">
                {t('chat.queuedImages', { count: item.images.length })}
              </span>
            )}
            <button
              type="button"
              aria-label={t('chat.sendNow', { chord: steerLabel })}
              title={t('chat.sendNow', { chord: steerLabel })}
              onClick={() => onSendNow(item.id)}
              disabled={blocked}
              className={`${buttonClass} disabled:pointer-events-none disabled:opacity-40`}
            >
              <SendHorizontal className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('chat.recallQueued')}
              title={t('chat.recallQueued')}
              onClick={() => onRecall(item.id)}
              className={buttonClass}
            >
              <Undo2 className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('chat.removeQueued')}
              title={t('chat.removeQueued')}
              onClick={() => onRemove(item.id)}
              className={buttonClass}
            >
              <X className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
});
