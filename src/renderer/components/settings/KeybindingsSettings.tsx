import {
  ACTION_IDS,
  type ActionId,
  chordFromEvent,
  conflictLabel,
  findConflict,
  formatChord,
  isAllowedChord,
  KEY_ACTIONS,
  type KeyScope,
} from '@shared/keybindings';
import { RotateCcw } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { KEY_PLATFORM } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { useKeybindingsStore } from '@/stores/settings';
import { InlineMessage, SectionHeader } from './common';

const GROUPS: { scope: KeyScope; title: string }[] = [
  { scope: 'global', title: '全局' },
  { scope: 'composer', title: '输入框' },
];

const NEEDS_MODIFIER = KEY_PLATFORM === 'mac' ? '要带 ⌘、⌃ 或 ⌥' : '要带 Ctrl 或 Alt';

/** 快捷键：每行「动作 — 当前键 — 改键 / 重置」。改键是按下新的组合键，冲突的不保存。 */
export function KeybindingsSettings() {
  const customized = useKeybindingsStore((state) => Object.keys(state.overrides).length > 0);
  const resetAll = useKeybindingsStore((state) => state.resetAll);
  const [recording, setRecording] = useState<ActionId | null>(null);

  return (
    <div className="grid gap-8">
      {GROUPS.map(({ scope, title }, index) => (
        <section key={scope}>
          <SectionHeader title={title}>
            {index === 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={!customized}
                onClick={(event) => {
                  // 按钮随即禁用、焦点会丢：交给第一行的「改键」
                  event.currentTarget
                    .closest('section')
                    ?.querySelector<HTMLButtonElement>('li button')
                    ?.focus();
                  void resetAll();
                }}
              >
                <RotateCcw />
                全部重置
              </Button>
            )}
          </SectionHeader>
          <ul className="divide-y rounded-lg border">
            {ACTION_IDS.filter((action) => KEY_ACTIONS[action].scope === scope).map((action) => (
              <KeyRow
                key={action}
                action={action}
                recording={recording === action}
                onRecordingChange={(next) => setRecording(next ? action : null)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function KeyRow({
  action,
  recording,
  onRecordingChange,
}: {
  action: ActionId;
  recording: boolean;
  onRecordingChange: (recording: boolean) => void;
}) {
  const bindings = useKeybindingsStore((state) => state.bindings);
  const custom = useKeybindingsStore((state) => state.overrides[action] !== undefined);
  const setChord = useKeybindingsStore((state) => state.setChord);
  const reset = useKeybindingsStore((state) => state.reset);
  const [problem, setProblem] = useState<string | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);
  const { label } = KEY_ACTIONS[action];
  const chord = bindings[action];
  // 手改 settings.json、或新版本的默认键撞上了改过的键
  const conflict = findConflict(action, chord, bindings, KEY_PLATFORM);
  const message = recording ? problem : conflict && `与「${conflictLabel(conflict)}」冲突`;

  useEffect(() => {
    if (recording) recorder.current?.focus();
  }, [recording]);

  const stop = () => {
    setProblem(null);
    onRecordingChange(false);
  };

  // 录键时按键都归这里：不触发按钮、不关设置视图、不派发全局快捷键
  const capture = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const pressed = chordFromEvent(event.nativeEvent);
    if (pressed === 'escape') {
      stop();
      return;
    }
    // 只按了修饰键：等主键
    if (pressed === null) return;
    if (!isAllowedChord(action, pressed)) {
      setProblem(NEEDS_MODIFIER);
      return;
    }
    const taken = findConflict(action, pressed, bindings, KEY_PLATFORM);
    if (taken) {
      setProblem(`已被「${conflictLabel(taken)}」使用`);
      return;
    }
    stop();
    void setChord(action, pressed);
  };

  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {message && (
        <InlineMessage tone="error" className="shrink-0">
          {message}
        </InlineMessage>
      )}
      {recording ? (
        <span className="shrink-0 rounded border border-dashed px-1.5 py-0.5 text-muted-foreground text-xs">
          按下组合键
        </span>
      ) : (
        <kbd className="shrink-0 rounded border bg-muted/60 px-1.5 py-0.5 font-sans text-xs">
          {formatChord(chord, KEY_PLATFORM)}
        </kbd>
      )}
      <Button
        ref={recorder}
        size="sm"
        variant="ghost"
        aria-label={recording ? '按下组合键，Esc 取消' : `改键：${label}`}
        onClick={() => {
          setProblem(null);
          onRecordingChange(!recording);
        }}
        onKeyDown={recording ? capture : undefined}
        onBlur={recording ? stop : undefined}
      >
        {recording ? '取消' : '改键'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`重置：${label}`}
        disabled={!custom}
        className={cn(!custom && 'invisible')}
        onClick={() => {
          // 按钮随即隐藏、焦点会丢：交给同一行的「改键」
          recorder.current?.focus();
          void reset(action);
        }}
      >
        重置
      </Button>
    </li>
  );
}
