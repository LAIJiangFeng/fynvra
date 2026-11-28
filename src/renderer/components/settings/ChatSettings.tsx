import {
  ARCHIVE_IDLE_DAYS,
  DELETE_ARCHIVED_DAYS,
  isArchiveIdleDays,
  isCompactionStrategy,
  isCompactionThresholdTokens,
  isDeleteArchivedDays,
  MAX_COMPACTION_THRESHOLD_TOKENS,
  MAX_COMPACTION_TIMEOUT_MS,
  MIN_COMPACTION_THRESHOLD_TOKENS,
  MIN_COMPACTION_TIMEOUT_MS,
  type TimelinePreferences,
  type WatchdogPreferences,
} from '@shared/types/settings';
import { Save } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { MessageId, T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { useGeneralPreferencesStore } from '@/stores/settings';
import { InlineMessage, SettingsCard, SettingsRow, SettingsSection } from './common';

/** 对话：时间线显示、会话归档与清理、上下文压缩、会话守护、安全。都是立即保存 */
export function ChatSettings() {
  return (
    <div className="grid gap-8">
      <TimelineSection />
      <SessionsSection />
      <CompactionSection />
      <WatchdogSection />
      <SafetySection />
    </div>
  );
}

/** 偏好写回失败时的错误（同一个 store，各小节在卡片下方显示） */
function PreferencesError() {
  const error = useGeneralPreferencesStore((state) => state.error);
  return error ? (
    <InlineMessage tone="error" className="mt-2">
      {error}
    </InlineMessage>
  ) : null;
}

// --- timeline ---
const TIMELINE_ROWS: { key: keyof TimelinePreferences; label: MessageId; hint: MessageId }[] = [
  {
    key: 'compactReadonlyTools',
    label: 'settings.general.compactReadonlyTools',
    hint: 'settings.general.compactReadonlyToolsHint',
  },
  {
    key: 'autoExpandEdits',
    label: 'settings.general.autoExpandEdits',
    hint: 'settings.general.autoExpandEditsHint',
  },
  {
    key: 'autoExpandThinking',
    label: 'settings.general.autoExpandThinking',
    hint: 'settings.general.autoExpandThinkingHint',
  },
  {
    key: 'foldHistoryTurns',
    label: 'settings.general.foldHistoryTurns',
    hint: 'settings.general.foldHistoryTurnsHint',
  },
];

function TimelineSection() {
  const timeline = useGeneralPreferencesStore((state) => state.timeline);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  return (
    <SettingsSection title={t('settings.general.display')}>
      <SettingsCard>
        {TIMELINE_ROWS.map(({ key, label, hint }) => (
          <SettingsRow
            key={key}
            label={t(label)}
            description={t(hint)}
            htmlFor={`${id}-${key}`}
            control={
              <Switch
                id={`${id}-${key}`}
                checked={timeline[key]}
                onCheckedChange={(checked) => void update({ [key]: checked })}
              />
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

// --- sessions ---
function daysItems(days: readonly number[], zero: string, t: T) {
  return days.map((value) => ({
    value: String(value),
    label: value === 0 ? zero : t('settings.general.days', { days: value }),
  }));
}

function SessionsSection() {
  const sessions = useGeneralPreferencesStore((state) => state.sessions);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  return (
    <SettingsSection title={t('settings.general.archive')}>
      <SettingsCard>
        <SettingsRow
          label={t('settings.general.archiveIdle')}
          description={t('settings.general.archiveIdleHint')}
          htmlFor={`${id}-idle`}
          control={
            <DaysSelect
              id={`${id}-idle`}
              items={daysItems(ARCHIVE_IDLE_DAYS, t('settings.general.off'), t)}
              value={sessions.archiveIdleDays}
              onChange={(days) => {
                if (isArchiveIdleDays(days)) void update({ archiveIdleDays: days });
              }}
            />
          }
        />
        <SettingsRow
          label={t('settings.general.deleteArchived')}
          description={t('settings.general.deleteArchivedHint')}
          htmlFor={`${id}-delete`}
          control={
            <DaysSelect
              id={`${id}-delete`}
              items={daysItems(DELETE_ARCHIVED_DAYS, t('settings.general.never'), t)}
              value={sessions.deleteArchivedDays}
              onChange={(days) => {
                if (isDeleteArchivedDays(days)) void update({ deleteArchivedDays: days });
              }}
            />
          }
        />
      </SettingsCard>
      <PreferencesError />
    </SettingsSection>
  );
}

function DaysSelect({
  id,
  items,
  value,
  onChange,
}: {
  id: string;
  items: { value: string; label: string }[];
  value: number;
  onChange: (days: number) => void;
}) {
  return (
    <Select items={items} value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger id={id} size="sm" className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// --- context ---
function CompactionSection() {
  const compaction = useGeneralPreferencesStore((state) => state.compaction);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  const items = [
    { value: 'magic-context', label: t('settings.general.compactionMagic') },
    { value: 'native', label: t('settings.general.compactionNative') },
    { value: 'off', label: t('settings.general.compactionOff') },
  ];
  return (
    <SettingsSection title={t('settings.general.compaction')}>
      <SettingsCard>
        <SettingsRow
          label={t('settings.general.compactionStrategy')}
          description={t('settings.general.compactionHint')}
          htmlFor={id}
          control={
            <Select
              items={items}
              value={compaction}
              onValueChange={(next) => {
                if (isCompactionStrategy(next)) void update({ compactionStrategy: next });
              }}
            >
              <SelectTrigger id={id} size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <CompactionThresholdRow disabled={compaction === 'off'} />
        <CompactionTimeoutRow />
      </SettingsCard>
      <PreferencesError />
    </SettingsSection>
  );
}

/** 单位 k token（200 = 200,000）；留空保存 = 恢复自动 */
function CompactionThresholdRow({ disabled }: { disabled: boolean }) {
  const threshold = useGeneralPreferencesStore((state) => state.compactionThresholdTokens);
  const update = useGeneralPreferencesStore((state) => state.update);
  const [value, setValue] = useState(threshold === undefined ? '' : String(threshold / 1_000));
  const [saving, setSaving] = useState(false);
  const t = useT();
  const id = useId();
  useEffect(() => setValue(threshold === undefined ? '' : String(threshold / 1_000)), [threshold]);
  const tokens = value.trim() === '' ? undefined : Number(value) * 1_000;
  const valid = tokens === undefined || isCompactionThresholdTokens(tokens);
  return (
    <SettingsRow
      label={t('settings.general.compactionThreshold')}
      description={t('settings.general.compactionThresholdHint')}
      htmlFor={id}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || saving || disabled) return;
            setSaving(true);
            void update({ compactionThresholdTokens: tokens }).finally(() => setSaving(false));
          }}
        >
          <Input
            id={id}
            className="w-28"
            type="number"
            min={MIN_COMPACTION_THRESHOLD_TOKENS / 1_000}
            max={MAX_COMPACTION_THRESHOLD_TOKENS / 1_000}
            step="1"
            placeholder={t('settings.general.compactionThresholdAuto')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={saving || disabled}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!valid || saving || disabled || tokens === threshold}
          >
            <Save />
            {t('common.save')}
          </Button>
        </form>
      }
    />
  );
}

function CompactionTimeoutRow() {
  const timeout = useGeneralPreferencesStore((state) => state.compactionTimeoutMs);
  const update = useGeneralPreferencesStore((state) => state.update);
  const [seconds, setSeconds] = useState(String(timeout / 1_000));
  const [saving, setSaving] = useState(false);
  const t = useT();
  const id = useId();
  useEffect(() => setSeconds(String(timeout / 1_000)), [timeout]);
  const ms = Number(seconds) * 1_000;
  const valid =
    seconds.trim() !== '' &&
    Number.isSafeInteger(ms) &&
    ms >= MIN_COMPACTION_TIMEOUT_MS &&
    ms <= MAX_COMPACTION_TIMEOUT_MS;
  return (
    <SettingsRow
      label={t('settings.general.compactionTimeout')}
      description={t('settings.general.compactionTimeoutHint')}
      htmlFor={id}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || saving) return;
            setSaving(true);
            void update({ compactionTimeoutMs: ms }).finally(() => setSaving(false));
          }}
        >
          <Input
            id={id}
            className="w-28"
            type="number"
            min={MIN_COMPACTION_TIMEOUT_MS / 1_000}
            max={MAX_COMPACTION_TIMEOUT_MS / 1_000}
            step="1"
            required
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
            disabled={saving}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!valid || saving || ms === timeout}
          >
            <Save />
            {t('common.save')}
          </Button>
        </form>
      }
    />
  );
}

// --- watchdog ---
/** 会话守护（preferences.watchdog）：整块写回，Main 下一次检查就按新设置 */
function WatchdogSection() {
  const watchdog = useGeneralPreferencesStore((state) => state.watchdog);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  const save = (patch: Partial<WatchdogPreferences>) =>
    update({ watchdog: { ...watchdog, ...patch } });
  const scopeItems = [
    { value: 'orchestrator', label: t('settings.watchdog.scopeOrchestrator') },
    { value: 'all', label: t('settings.watchdog.scopeAll') },
  ];
  const triggers = [
    {
      key: 'onModelError',
      label: 'settings.watchdog.onModelError',
      hint: 'settings.watchdog.onModelErrorHint',
    },
    { key: 'onCrash', label: 'settings.watchdog.onCrash', hint: 'settings.watchdog.onCrashHint' },
    { key: 'onStall', label: 'settings.watchdog.onStall', hint: 'settings.watchdog.onStallHint' },
  ] as const;
  // 数字项：前两项排在触发开关前，「卡住分钟数」排在最后且随「长时间无输出」开关禁用
  const numbers = [
    {
      field: 'intervalSeconds',
      label: 'settings.watchdog.interval',
      hint: 'settings.watchdog.intervalHint',
      min: 15,
      max: 1800,
    },
    {
      field: 'maxAttempts',
      label: 'settings.watchdog.maxAttempts',
      hint: 'settings.watchdog.maxAttemptsHint',
      min: 1,
      max: 50,
    },
    {
      field: 'stallMinutes',
      label: 'settings.watchdog.stallMinutes',
      hint: 'settings.watchdog.stallMinutesHint',
      min: 10,
      max: 240,
    },
  ] as const;
  const renderNumber = ({ field, label, hint, min, max }: (typeof numbers)[number]) => (
    <SettingsRow
      key={field}
      label={t(label)}
      description={t(hint)}
      htmlFor={`${id}-${field}`}
      control={
        <WatchdogNumberInput
          id={`${id}-${field}`}
          field={field}
          min={min}
          max={max}
          disabled={field === 'stallMinutes' && !watchdog.onStall}
        />
      }
    />
  );
  return (
    <SettingsSection title={t('settings.watchdog.title')}>
      <SettingsCard>
        <SettingsRow
          label={t('settings.watchdog.enabled')}
          description={t('settings.watchdog.hint')}
          htmlFor={id}
          control={
            <Switch
              id={id}
              checked={watchdog.enabled}
              onCheckedChange={(checked) => void save({ enabled: checked })}
            />
          }
        />
        {watchdog.enabled && (
          <>
            <SettingsRow
              label={t('settings.watchdog.scope')}
              description={t('settings.watchdog.scopeHint')}
              htmlFor={`${id}-scope`}
              control={
                <Select
                  items={scopeItems}
                  value={watchdog.scope}
                  onValueChange={(next) => {
                    if (next === 'orchestrator' || next === 'all') void save({ scope: next });
                  }}
                >
                  <SelectTrigger id={`${id}-scope`} size="sm" className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            {numbers.slice(0, 2).map(renderNumber)}
            {triggers.map(({ key, label, hint }) => (
              <SettingsRow
                key={key}
                label={t(label)}
                description={t(hint)}
                htmlFor={`${id}-${key}`}
                control={
                  <Switch
                    id={`${id}-${key}`}
                    checked={watchdog[key]}
                    onCheckedChange={(checked) => void save({ [key]: checked })}
                  />
                }
              />
            ))}
            {numbers.slice(2).map(renderNumber)}
          </>
        )}
      </SettingsCard>
      <PreferencesError />
    </SettingsSection>
  );
}

/** 守护里的整数项：失焦或回车时，值合法且有变化才整块提交；不合法则失焦后恢复已保存的值 */
function WatchdogNumberInput({
  id,
  field,
  min,
  max,
  disabled = false,
}: {
  id: string;
  field: 'intervalSeconds' | 'maxAttempts' | 'stallMinutes';
  min: number;
  max: number;
  disabled?: boolean;
}) {
  const watchdog = useGeneralPreferencesStore((state) => state.watchdog);
  const update = useGeneralPreferencesStore((state) => state.update);
  const current = watchdog[field];
  const [value, setValue] = useState(String(current));
  useEffect(() => setValue(String(current)), [current]);
  const parsed = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max;
  const commit = () => {
    if (!valid) setValue(String(current));
    else if (parsed !== current) void update({ watchdog: { ...watchdog, [field]: parsed } });
  };
  return (
    <Input
      id={id}
      aria-invalid={!valid}
      className="w-24"
      type="number"
      min={min}
      max={max}
      step="1"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && valid) commit();
      }}
      disabled={disabled}
    />
  );
}

// --- safety ---
/**
 * 完全放行档下保护底线是否仍要确认（confirmDangerousActions，已打开的会话立即生效）；
 * web_fetch 是否允许访问本机回环地址（webFetchAllowLoopback，之后新加载的会话生效）
 */
function SafetySection() {
  const confirm = useGeneralPreferencesStore((state) => state.confirmDangerousActions);
  const allowLoopback = useGeneralPreferencesStore((state) => state.webFetchAllowLoopback);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  return (
    <SettingsSection title={t('settings.dangerousActions.title')}>
      <SettingsCard>
        <SettingsRow
          label={t('settings.dangerousActions.confirm')}
          description={t('settings.dangerousActions.hint')}
          htmlFor={`${id}-confirm`}
          control={
            <Switch
              id={`${id}-confirm`}
              checked={confirm}
              onCheckedChange={(checked) => void update({ confirmDangerousActions: checked })}
            />
          }
        />
        <SettingsRow
          label={t('settings.webFetch.allowLoopback')}
          description={t('settings.webFetch.hint')}
          htmlFor={`${id}-loopback`}
          control={
            <Switch
              id={`${id}-loopback`}
              checked={allowLoopback}
              onCheckedChange={(checked) => void update({ webFetchAllowLoopback: checked })}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
