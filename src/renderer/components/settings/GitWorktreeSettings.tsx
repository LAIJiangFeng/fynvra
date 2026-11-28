import { errorMessage } from '@shared/guards';
import { DEFAULT_NETWORK_PROXY } from '@shared/networkProxy';
import type { WorkspaceWorktreesInfo, WorktreesRootInfo } from '@shared/types/settings';
import { FolderOpen, FolderTree, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useGeneralPreferencesStore, useWorktreesRootStore } from '@/stores/settings';
import { useWorkspacesStore } from '@/stores/workspaces';
import { EmptyState, InlineMessage, SettingsCard, SettingsRow, SettingsSection } from './common';

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

/** Git 兼容模式：单独立即保存，只改已保存的 networkProxy.gitCompatibility，其余字段原样写回 */
function GitCompatibilityRow() {
  const t = useT();
  const id = useId();
  const [checked, setChecked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let request = 0;
    const load = () => {
      const current = ++request;
      window.fynvra.settings
        .get()
        .then((result) => {
          if (current !== request) return;
          if (result.ok) {
            setChecked((result.preferences.networkProxy ?? DEFAULT_NETWORK_PROXY).gitCompatibility);
          } else setError(result.error);
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

  const save = async (gitCompatibility: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // 先读最新已保存的代理设置，避免覆盖别处刚保存的模式与地址
      const saved = await window.fynvra.settings.get();
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      const current = saved.preferences.networkProxy ?? DEFAULT_NETWORK_PROXY;
      const result = await window.fynvra.settings.update({
        networkProxy: { ...current, gitCompatibility },
      });
      if (result.ok) {
        setChecked((result.preferences.networkProxy ?? DEFAULT_NETWORK_PROXY).gitCompatibility);
      } else setError(result.error);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      label={t('settings.network.compatibility')}
      description={t('settings.network.compatibilityHint')}
      htmlFor={id}
      control={
        <Switch
          id={id}
          checked={checked ?? false}
          disabled={busy || checked === null}
          onCheckedChange={(next) => void save(next)}
        />
      }
    >
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
    </SettingsRow>
  );
}

/** Git 兼容模式、worktree 放在哪（Main 弹框选择并校验，Renderer 不传路径）、各工作区登记的 worktree 占用、归档时是否清理 */
export function GitWorktreeSettings() {
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
    <>
      <SettingsSection title={t('settings.git.worktree')}>
        <SettingsCard>
          <SettingsRow
            label={t('settings.general.worktreeLocation')}
            description={<RootSummary info={info} failed={error !== null} />}
            control={
              <div className="flex gap-2">
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
              </div>
            }
          >
            {status ? (
              <InlineMessage tone={status.tone} className="break-all">
                {status.text}
              </InlineMessage>
            ) : null}
          </SettingsRow>
          <CleanupOnArchiveRow />
          <GitCompatibilityRow />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.general.diskUsage')}
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={measuring || info === null}
            onClick={() => void refresh({ measure: true })}
          >
            <RefreshCw className={cn(measuring && 'animate-spin')} />
            {t('settings.general.remeasure')}
          </Button>
        }
      >
        {error && (
          <InlineMessage tone="error" className="mb-3 break-all">
            {error}
          </InlineMessage>
        )}
        {info === null ? null : info.workspaces.length === 0 ? (
          <EmptyState icon={FolderTree} title={t('settings.general.noWorkspaces')} />
        ) : (
          <SettingsCard>
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
          </SettingsCard>
        )}
      </SettingsSection>
    </>
  );
}

function CleanupOnArchiveRow() {
  const cleanup = useGeneralPreferencesStore((state) => state.sessions.cleanupWorktreeOnArchive);
  const update = useGeneralPreferencesStore((state) => state.update);
  const error = useGeneralPreferencesStore((state) => state.error);
  const t = useT();
  const id = useId();
  return (
    <SettingsRow
      label={t('settings.general.cleanupOnArchive')}
      description={t('settings.general.cleanupOnArchiveHint')}
      htmlFor={id}
      control={
        <Switch
          id={id}
          checked={cleanup}
          onCheckedChange={(checked) => void update({ cleanupWorktreeOnArchive: checked })}
        />
      }
    >
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
    </SettingsRow>
  );
}

function RootSummary({ info, failed }: { info: WorktreesRootInfo | null; failed: boolean }) {
  const t = useT();
  if (info === null) return <p>{t(failed ? 'common.loadFailed' : 'common.loading')}</p>;
  // 作为行内说明：布局名 + 路径或命名规则，规则与退回位置放在悬停提示里
  if (info.isDefault) {
    return (
      <div className="grid gap-0.5">
        <div className="flex items-center gap-2">
          <span>{t('settings.general.besideRepo')}</span>
          <Badge variant="outline">{t('common.default')}</Badge>
        </div>
        <p
          className="font-mono"
          title={t('settings.general.fallbackHint', { path: info.fallbackRoot })}
        >
          {t('settings.general.besideRepoPattern')}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-0.5">
      <span>{t('settings.general.customFolder')}</span>
      <p className="break-all font-mono" title={t('settings.general.customFolderHint')}>
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
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="font-medium text-sm">{workspace.name}</span>
        <Badge variant="outline" title={t('common.noWorktrees')}>
          {t('common.noGit')}
        </Badge>
      </div>
    );
  }
  const { usage } = workspace;
  const size = usage ? formatBytes(usage.bytes) : measuring ? t('settings.general.measuring') : '—';
  return (
    <div className="flex items-start gap-3 px-4 py-3">
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
    </div>
  );
}
