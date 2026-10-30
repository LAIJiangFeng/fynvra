import { errorMessage } from '@shared/guards';
import { isLanguage, LANGUAGES, type Language, type Locale } from '@shared/i18n';
import {
  ARCHIVE_IDLE_DAYS,
  type AvailableShells,
  DELETE_ARCHIVED_DAYS,
  isArchiveIdleDays,
  isCompactionStrategy,
  isDeleteArchivedDays,
  languageOf,
  MAX_COMPACTION_TIMEOUT_MS,
  MIN_COMPACTION_TIMEOUT_MS,
  type Preferences,
  parseShellPreference,
  type ShellPreference,
  type ShellTarget,
  type TimelinePreferences,
  type WorkspaceWorktreesInfo,
  type WorktreesRootInfo,
} from '@shared/types/settings';
import { FolderOpen, FolderTree, Minimize2, RefreshCw, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import {
  useGeneralPreferencesStore,
  useSettingsStore,
  useWorktreesRootStore,
} from '@/stores/settings';
import { useWorkspacesStore } from '@/stores/workspaces';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { NetworkProxySettings } from './NetworkProxySettings';
import { UpdateSettings } from './UpdateSettings';

type Status = { tone: 'error' | 'success'; text: string };

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1024 进制；不足 10 的保留一位小数。 */
function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/**
 * 通用：界面语言，worktree 放在哪（Main 弹框选择并校验，Renderer 不传路径）、各工作区登记的 worktree 占用，
 * 会话的归档与清理，时间线的显示偏好。
 */
export function GeneralSettings() {
  const info = useWorktreesRootStore((state) => state.info);
  const measuring = useWorktreesRootStore((state) => state.measuring);
  const error = useWorktreesRootStore((state) => state.error);
  const refresh = useWorktreesRootStore((state) => state.refresh);
  const pick = useWorktreesRootStore((state) => state.pick);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh({ measure: true });
  }, [refresh]);

  const choose = async (input?: { reset: true }) => {
    setBusy(true);
    const result = await pick(input);
    setBusy(false);
    if (result.ok) {
      const root = result.preferences.worktreesRoot;
      setStatus({
        tone: 'success',
        text: root
          ? t('settings.general.worktreesGoTo', { root })
          : t('settings.general.worktreesReset'),
      });
    } else if (result.code !== 'canceled') {
      setStatus({ tone: 'error', text: result.error });
    }
  };

  return (
    <div className="grid gap-8">
      <LanguageSection />
      <ShellsSection />
      <NetworkProxySettings />

      <section>
        <SectionHeader title={t('settings.general.worktreeLocation')}>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || info === null || info.isDefault}
            onClick={() => void choose({ reset: true })}
          >
            <RotateCcw />
            {t('settings.general.resetDefault')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void choose()}>
            <FolderOpen />
            {t('settings.general.chooseFolder')}
          </Button>
        </SectionHeader>
        <RootSummary info={info} failed={error !== null} />
        {status && (
          <InlineMessage tone={status.tone} className="mt-2 break-all">
            {status.text}
          </InlineMessage>
        )}
      </section>

      <section>
        <SectionHeader title={t('settings.general.diskUsage')}>
          <Button
            size="sm"
            variant="outline"
            disabled={measuring || info === null}
            onClick={() => void refresh({ measure: true })}
          >
            <RefreshCw className={cn(measuring && 'animate-spin')} />
            {t('settings.general.remeasure')}
          </Button>
        </SectionHeader>
        {error && (
          <InlineMessage tone="error" className="mb-3 break-all">
            {error}
          </InlineMessage>
        )}
        {info === null ? null : info.workspaces.length === 0 ? (
          <EmptyState icon={FolderTree} title={t('settings.general.noWorkspaces')} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {info.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.workspaceId}
                workspace={workspace}
                plain={workspaces.some(
                  (candidate) => candidate.id === workspace.workspaceId && candidate.vcs === 'none'
                )}
                measuring={measuring}
              />
            ))}
          </ul>
        )}
      </section>

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
          label={t('settings.general.cleanupOnArchive')}
          hint={t('settings.general.cleanupOnArchiveHint')}
        >
          {(id) => (
            <Switch
              id={id}
              aria-label={t('settings.general.cleanupOnArchive')}
              checked={sessions.cleanupWorktreeOnArchive}
              onCheckedChange={(checked) => void update({ cleanupWorktreeOnArchive: checked })}
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
      <CompactionTimeoutSetting />
    </section>
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

function RootSummary({ info, failed }: { info: WorktreesRootInfo | null; failed: boolean }) {
  const t = useT();
  if (info === null) {
    return (
      <p className="rounded-lg border px-4 py-3 text-muted-foreground text-sm">
        {t(failed ? 'common.loadFailed' : 'common.loading')}
      </p>
    );
  }
  // 布局一行写出来（路径或命名规则），规则与退回位置放在悬停提示里
  if (info.isDefault) {
    return (
      <div className="grid gap-1 rounded-lg border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{t('settings.general.besideRepo')}</span>
          <Badge variant="outline">{t('common.default')}</Badge>
        </div>
        <p
          className="font-mono text-muted-foreground text-xs"
          title={t('settings.general.fallbackHint', { path: info.fallbackRoot })}
        >
          {t('settings.general.besideRepoPattern')}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-1 rounded-lg border px-4 py-3">
      <span className="font-medium text-sm">{t('settings.general.customFolder')}</span>
      <p className="break-all font-mono text-xs" title={t('settings.general.customFolderHint')}>
        {info.worktreesRoot}
      </p>
    </div>
  );
}

function WorkspaceRow({
  workspace,
  plain,
  measuring,
}: {
  workspace: WorkspaceWorktreesInfo;
  /** 无 git 的工作区不建 worktree，不给位置与占用 */
  plain: boolean;
  measuring: boolean;
}) {
  const t = useT();
  if (plain) {
    return (
      <li className="flex items-center gap-2 px-4 py-3">
        <span className="font-medium text-sm">{workspace.name}</span>
        <Badge variant="outline" title={t('common.noWorktrees')}>
          {t('common.noGit')}
        </Badge>
      </li>
    );
  }
  const { usage } = workspace;
  const size = usage ? formatBytes(usage.bytes) : measuring ? t('settings.general.measuring') : '—';
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{workspace.name}</span>
          {workspace.fallback && (
            <Badge variant="outline" title={workspace.fallback}>
              {t('settings.general.fellBack')}
            </Badge>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={workspace.root}>
          {t('settings.general.newWorktreesIn', { root: workspace.root })}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn('font-medium text-sm tabular-nums', !usage && 'text-muted-foreground')}>
          {size}
        </p>
        <p className="text-muted-foreground text-xs">
          {t('settings.general.worktreeCount', { count: workspace.count })}
          {usage && usage.missing > 0
            ? t('settings.general.missingDirs', { count: usage.missing })
            : ''}
        </p>
      </div>
    </li>
  );
}
