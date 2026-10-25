import { isLanguage, LANGUAGES, type Language, type Locale } from '@shared/i18n';
import {
  ARCHIVE_IDLE_DAYS,
  DELETE_ARCHIVED_DAYS,
  isArchiveIdleDays,
  isDeleteArchivedDays,
  languageOf,
  type TimelinePreferences,
  type WorkspaceWorktreesInfo,
  type WorktreesRootInfo,
} from '@shared/types/settings';
import { FolderOpen, FolderTree, RefreshCw, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
      <TimelineSection />
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
