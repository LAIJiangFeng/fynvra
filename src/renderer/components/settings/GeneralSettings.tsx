import { errorMessage } from '@shared/guards';
import { isLanguage, LANGUAGES, type Language, type Locale } from '@shared/i18n';
import {
  ARCHIVE_IDLE_DAYS,
  type AvailableShells,
  DELETE_ARCHIVED_DAYS,
  isArchiveIdleDays,
  isCompactionStrategy,
  isCompactionThresholdTokens,
  isDeleteArchivedDays,
  languageOf,
  MAX_COMPACTION_THRESHOLD_TOKENS,
  MAX_COMPACTION_TIMEOUT_MS,
  MIN_COMPACTION_THRESHOLD_TOKENS,
  MIN_COMPACTION_TIMEOUT_MS,
  type Preferences,
  parseShellPreference,
  type ShellPreference,
  type ShellTarget,
  type TimelinePreferences,
  type WatchdogPreferences,
} from '@shared/types/settings';
import { FolderOpen, Minimize2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
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
import { useGeneralPreferencesStore, useSettingsStore } from '@/stores/settings';
import { InlineMessage, SectionHeader } from './common';
import { NetworkProxySettings } from './NetworkProxySettings';
import { UpdateSettings } from './UpdateSettings';

/**
 * 通用：界面语言、Shell、网络代理、安全与守护，会话的归档与清理，上下文压缩，时间线的显示偏好。
 */
export function GeneralSettings() {
  return (
    <div className="grid gap-8">
      <LanguageSection />
      <ShellsSection />
      <NetworkProxySettings />
      <DangerousActionsSection />
      <WebFetchSection />
      <WatchdogSection />

      <SessionsSection />
      <CompactionSection />
      <TimelineSection />
      <UpdateSettings />
    </div>
  );
}

// --- language ---
/** 语言名用各自的写法、不随界面语言变：切错了也认得出回去的那一项 */
const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { 'zh-CN': '简体中文', en: 'English' };

function LanguageSection() {
  const language = useSettingsStore((state) => languageOf(state));
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const t = useT();
  const items = LANGUAGES.map((value: Language) => ({
    value,
    label: value === 'system' ? t('settings.general.followSystem') : LANGUAGE_NAMES[value],
  }));
  return (
    <section>
      <SectionHeader title={t('settings.general.language')}>
        <Select
          items={items}
          value={language}
          onValueChange={(next) => {
            if (isLanguage(next)) setLanguage(next);
          }}
        >
          <SelectTrigger size="sm" className="w-36" aria-label={t('settings.general.language')}>
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
      </SectionHeader>
    </section>
  );
}

// --- shells ---
function ShellsSection() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [available, setAvailable] = useState<AvailableShells | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const windows = window.fynvra.window.platform === 'win32';
  const t = useT();

  useEffect(() => {
    let request = 0;
    const load = () => {
      const current = ++request;
      void Promise.all([window.fynvra.settings.get(), window.fynvra.settings.availableShells()])
        .then(([saved, shells]) => {
          if (current !== request) return;
          if (saved.ok) setPreferences(saved.preferences);
          if (shells.ok) setAvailable(shells);
          if (!saved.ok) setError(saved.error);
          else if (!shells.ok) setError(shells.error);
        })
        .catch((failure) => {
          if (current === request) setError(errorMessage(failure));
        });
    };
    const unsubscribe = window.fynvra.settings.onChanged(load);
    load();
    return () => {
      request += 1;
      unsubscribe();
    };
  }, []);

  const save = async (target: ShellTarget, value: ShellPreference | undefined, browse = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = browse
        ? await window.fynvra.settings.pickShell(target)
        : await window.fynvra.settings.update({ [target]: value });
      if (result.ok) setPreferences(result.preferences);
      else if (!('code' in result && result.code === 'canceled')) setError(result.error);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <ul className="divide-y rounded-lg border">
        {(windows ? (['agentShell', 'terminalShell'] as const) : (['terminalShell'] as const)).map(
          (target) => (
            <ShellPreferenceRow
              key={target}
              target={target}
              preference={preferences?.[target]}
              legacy={target === 'agentShell' ? preferences?.shellPath : undefined}
              available={available}
              disabled={busy || !preferences || !available}
              windows={windows}
              onSave={(value) => void save(target, value)}
              onBrowse={() => void save(target, undefined, true)}
            />
          )
        )}
      </ul>
      {error && (
        <InlineMessage tone="error" className="mt-2">
          {error}
        </InlineMessage>
      )}
      {!available && !error && (
        <p className="mt-2 text-muted-foreground text-xs">{t('common.loading')}</p>
      )}
    </section>
  );
}

function ShellPreferenceRow({
  target,
  preference,
  legacy,
  available,
  disabled,
  windows,
  onSave,
  onBrowse,
}: {
  target: ShellTarget;
  preference: ShellPreference | undefined;
  legacy?: string;
  available: AvailableShells | null;
  disabled: boolean;
  windows: boolean;
  onSave: (value: ShellPreference | undefined) => void;
  onBrowse: () => void;
}) {
  const t = useT();
  const id = useId();
  const agent = target === 'agentShell';
  const [editingCustom, setEditingCustom] = useState(false);
  const savedPath = preference?.kind === 'custom' ? preference.path : '';
  const [path, setPath] = useState(savedPath);
  useEffect(() => {
    setPath(savedPath);
  }, [savedPath]);
  const custom = !legacy && (editingCustom || preference?.kind === 'custom');
  const value = legacy || custom ? 'custom' : (preference?.kind ?? 'default');
  const resolved = agent ? available?.agentPath : available?.terminalPath;
  const items = [
    {
      value: 'default',
      label: t(
        agent
          ? 'settings.general.agentShellDefault'
          : windows
            ? 'settings.general.terminalShellDefault'
            : 'settings.general.loginShellDefault'
      ),
    },
    ...(available?.shells ?? [])
      .filter((shell) => !agent || shell.agentSupported)
      .map((shell) => ({
        value: shell.id,
        label: shell.id === 'login' ? t('settings.general.loginShell') : shell.label,
      })),
    {
      value: 'custom',
      label: t(legacy ? 'settings.general.shellCustom' : 'settings.general.shellCustomChoose'),
    },
  ];
  if (!items.some((item) => item.value === value)) {
    items.push({ value, label: t('settings.general.shellUnavailable', { name: value }) });
  }
  const parsed = parseShellPreference({ kind: 'custom', path }, agent);
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0 pt-1">
        <label htmlFor={id} className="font-medium text-sm">
          {t(agent ? 'settings.general.agentShell' : 'settings.general.terminalShell')}
        </label>
        <p className="mt-1 text-muted-foreground text-xs">
          {t(agent ? 'settings.general.agentShellHint' : 'settings.general.terminalShellHint')}
        </p>
      </div>
      <div className="grid w-64 shrink-0 gap-2">
        <Select
          items={items}
          value={value}
          disabled={disabled || Boolean(legacy)}
          onValueChange={(next) => {
            if (next === 'custom') {
              setEditingCustom(true);
              return;
            }
            const choice =
              next === 'default' ? undefined : parseShellPreference({ kind: next }, agent);
            if (next !== 'default' && !choice) return;
            setEditingCustom(false);
            onSave(choice);
          }}
        >
          <SelectTrigger id={id} size="sm" className="w-full" title={legacy ?? resolved}>
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
        <p className="truncate font-mono text-muted-foreground text-xs" title={legacy ?? resolved}>
          {legacy ?? resolved ?? t('settings.general.shellNotFound')}
        </p>
        {legacy && (
          <p className="text-muted-foreground text-xs">{t('settings.general.shellLegacyHint')}</p>
        )}
        {custom && (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (parsed) onSave(parsed);
            }}
          >
            <Input
              aria-label={t('settings.general.shellPath')}
              placeholder={t('settings.general.shellPath')}
              value={path}
              disabled={disabled}
              onChange={(event) => setPath(event.target.value)}
            />
            {agent && (
              <p className="text-muted-foreground text-xs">
                {t('settings.general.shellCommandHint')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={onBrowse}
              >
                <FolderOpen />
                {t('settings.general.shellBrowse')}
              </Button>
              <Button type="submit" size="sm" disabled={disabled || !parsed}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </li>
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
  const error = useGeneralPreferencesStore((state) => state.error);
  const t = useT();
  return (
    <section>
      <SectionHeader title={t('settings.general.sessions')} />
      <ul className="divide-y rounded-lg border">
        <PreferenceRow
          label={t('settings.general.archiveIdle')}
          hint={t('settings.general.archiveIdleHint')}
        >
          {(id) => (
            <DaysSelect
              id={id}
              items={daysItems(ARCHIVE_IDLE_DAYS, t('settings.general.off'), t)}
              value={sessions.archiveIdleDays}
              onChange={(days) => {
                if (isArchiveIdleDays(days)) void update({ archiveIdleDays: days });
              }}
            />
          )}
        </PreferenceRow>
        <PreferenceRow
          label={t('settings.general.deleteArchived')}
          hint={t('settings.general.deleteArchivedHint')}
        >
          {(id) => (
            <DaysSelect
              id={id}
              items={daysItems(DELETE_ARCHIVED_DAYS, t('settings.general.never'), t)}
              value={sessions.deleteArchivedDays}
              onChange={(days) => {
                if (isDeleteArchivedDays(days)) void update({ deleteArchivedDays: days });
              }}
            />
          )}
        </PreferenceRow>
      </ul>
      {error && (
        <InlineMessage tone="error" className="mt-2">
          {error}
        </InlineMessage>
      )}
    </section>
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

// --- dangerous actions ---
/** 完全放行档下保护底线是否仍要确认（preferences.confirmDangerousActions）：已打开的会话立即生效 */
function DangerousActionsSection() {
  const confirm = useGeneralPreferencesStore((state) => state.confirmDangerousActions);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  return (
    <section>
      <SectionHeader title={t('settings.dangerousActions.title')} />
      <ul className="divide-y rounded-lg border">
        <li className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <label htmlFor={id} className="font-medium text-sm">
              {t('settings.dangerousActions.confirm')}
            </label>
            <p className="mt-1 text-muted-foreground text-xs">
              {t('settings.dangerousActions.hint')}
            </p>
          </div>
          <Switch
            id={id}
            checked={confirm}
            onCheckedChange={(checked) => void update({ confirmDangerousActions: checked })}
          />
        </li>
      </ul>
    </section>
  );
}

// --- web fetch ---
/** web_fetch 是否允许访问本机回环地址（preferences.webFetchAllowLoopback）：之后新加载的会话生效 */
function WebFetchSection() {
  const allowLoopback = useGeneralPreferencesStore((state) => state.webFetchAllowLoopback);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  return (
    <section>
      <SectionHeader title={t('settings.webFetch.title')} />
      <ul className="divide-y rounded-lg border">
        <li className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <label htmlFor={id} className="font-medium text-sm">
              {t('settings.webFetch.allowLoopback')}
            </label>
            <p className="mt-1 text-muted-foreground text-xs">{t('settings.webFetch.hint')}</p>
          </div>
          <Switch
            id={id}
            checked={allowLoopback}
            onCheckedChange={(checked) => void update({ webFetchAllowLoopback: checked })}
          />
        </li>
      </ul>
    </section>
  );
}

// --- watchdog ---
/** 会话守护（preferences.watchdog）：整块写回，Main 下一次检查就按新设置 */
function WatchdogSection() {
  const watchdog = useGeneralPreferencesStore((state) => state.watchdog);
  const update = useGeneralPreferencesStore((state) => state.update);
  const error = useGeneralPreferencesStore((state) => state.error);
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
    <PreferenceRow key={field} label={t(label)} hint={t(hint)}>
      {(rowId) => (
        <WatchdogNumberInput
          id={rowId}
          field={field}
          label={t(label)}
          min={min}
          max={max}
          disabled={field === 'stallMinutes' && !watchdog.onStall}
        />
      )}
    </PreferenceRow>
  );
  return (
    <section>
      <SectionHeader title={t('settings.watchdog.title')} />
      <ul className="divide-y rounded-lg border">
        <li className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <label htmlFor={id} className="font-medium text-sm">
              {t('settings.watchdog.enabled')}
            </label>
            <p className="mt-1 text-muted-foreground text-xs">{t('settings.watchdog.hint')}</p>
          </div>
          <Switch
            id={id}
            checked={watchdog.enabled}
            onCheckedChange={(checked) => void save({ enabled: checked })}
          />
        </li>
        {watchdog.enabled && (
          <>
            <PreferenceRow label={t('settings.watchdog.scope')} hint={t('settings.watchdog.scope')}>
              {(rowId) => (
                <Select
                  items={scopeItems}
                  value={watchdog.scope}
                  onValueChange={(next) => {
                    if (next === 'orchestrator' || next === 'all') void save({ scope: next });
                  }}
                >
                  <SelectTrigger id={rowId} size="sm" className="w-56">
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
              )}
            </PreferenceRow>
            {numbers.slice(0, 2).map(renderNumber)}
            {triggers.map(({ key, label, hint }) => (
              <PreferenceRow key={key} label={t(label)} hint={t(hint)}>
                {(rowId) => (
                  <Switch
                    id={rowId}
                    aria-label={t(label)}
                    checked={watchdog[key]}
                    onCheckedChange={(checked) => void save({ [key]: checked })}
                  />
                )}
              </PreferenceRow>
            ))}
            {numbers.slice(2).map(renderNumber)}
          </>
        )}
      </ul>
      {error && (
        <InlineMessage tone="error" className="mt-2">
          {error}
        </InlineMessage>
      )}
    </section>
  );
}

/** 守护里的整数项：失焦或回车时，值合法且有变化才整块提交；不合法则失焦后恢复已保存的值 */
function WatchdogNumberInput({
  id,
  field,
  label,
  min,
  max,
  disabled = false,
}: {
  id: string;
  field: 'intervalSeconds' | 'maxAttempts' | 'stallMinutes';
  label: string;
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
      aria-label={label}
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

// --- context ---
function CompactionSection() {
  const compaction = useGeneralPreferencesStore((state) => state.compaction);
  const update = useGeneralPreferencesStore((state) => state.update);
  const t = useT();
  const id = useId();
  const hint = t('settings.general.compactionHint');
  const items = [
    { value: 'magic-context', label: t('settings.general.compactionMagic') },
    { value: 'native', label: t('settings.general.compactionNative') },
    { value: 'off', label: t('settings.general.compactionOff') },
  ];
  return (
    <section>
      <SectionHeader title={t('settings.general.compaction')} />
      <ul className="divide-y rounded-lg border">
        <li className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Minimize2 className="size-4 shrink-0 text-muted-foreground" />
            <label htmlFor={id} title={hint} className="min-w-0 text-sm">
              {t('settings.general.compactionSelected')}
            </label>
          </div>
          <Select
            items={items}
            value={compaction}
            onValueChange={(next) => {
              if (isCompactionStrategy(next)) void update({ compactionStrategy: next });
            }}
          >
            <SelectTrigger
              id={id}
              size="sm"
              className="w-56"
              title={hint}
              aria-label={t('settings.general.compactionSelected')}
            >
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
        </li>
      </ul>
      <p className="mt-2 text-muted-foreground text-xs">{hint}</p>
      <CompactionThresholdSetting disabled={compaction === 'off'} />
      <CompactionTimeoutSetting />
    </section>
  );
}

/** 单位 k token（200 = 200,000）；留空保存 = 恢复自动 */
function CompactionThresholdSetting({ disabled }: { disabled: boolean }) {
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
    <form
      className="mt-3 grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || saving || disabled) return;
        setSaving(true);
        void update({ compactionThresholdTokens: tokens }).finally(() => setSaving(false));
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="mr-auto text-sm">
          {t('settings.general.compactionThreshold')}
        </label>
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
          {t('common.save')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('settings.general.compactionThresholdHint')}
      </p>
    </form>
  );
}

function CompactionTimeoutSetting() {
  const timeout = useGeneralPreferencesStore((state) => state.compactionTimeoutMs);
  const update = useGeneralPreferencesStore((state) => state.update);
  const error = useGeneralPreferencesStore((state) => state.error);
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
    <form
      className="mt-3 grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || saving) return;
        setSaving(true);
        void update({ compactionTimeoutMs: ms }).finally(() => setSaving(false));
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="mr-auto text-sm">
          {t('settings.general.compactionTimeout')}
        </label>
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
          {t('common.save')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">{t('settings.general.compactionTimeoutHint')}</p>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </form>
  );
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
  return (
    <section>
      <SectionHeader title={t('settings.general.timeline')} />
      <ul className="divide-y rounded-lg border">
        {TIMELINE_ROWS.map(({ key, label, hint }) => (
          <PreferenceRow key={key} label={t(label)} hint={t(hint)}>
            {(id) => (
              <Switch
                id={id}
                aria-label={t(label)}
                checked={timeline[key]}
                onCheckedChange={(checked) => void update({ [key]: checked })}
              />
            )}
          </PreferenceRow>
        ))}
      </ul>
    </section>
  );
}

/** 一行设置：左边是控件名（说明在悬停提示里），右边是控件；标签经 htmlFor 关联到控件 */
function PreferenceRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <li className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
      <label htmlFor={id} title={hint} className="min-w-0 text-sm">
        {label}
      </label>
      {children(id)}
    </li>
  );
}
