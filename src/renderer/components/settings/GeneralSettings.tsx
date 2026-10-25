import {
  ARCHIVE_IDLE_DAYS,
  DELETE_ARCHIVED_DAYS,
  isArchiveIdleDays,
  isDeleteArchivedDays,
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
import { cn } from '@/lib/utils';
import { useGeneralPreferencesStore, useWorktreesRootStore } from '@/stores/settings';
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
 * 通用：worktree 放在哪（Main 弹框选择并校验，Renderer 不传路径）、各工作区登记的 worktree 占用，
 * 会话的归档与清理，时间线的显示偏好。
 */
export function GeneralSettings() {
  const info = useWorktreesRootStore((state) => state.info);
  const measuring = useWorktreesRootStore((state) => state.measuring);
  const error = useWorktreesRootStore((state) => state.error);
  const refresh = useWorktreesRootStore((state) => state.refresh);
  const pick = useWorktreesRootStore((state) => state.pick);
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
          ? `之后新建的 worktree 放在 ${root} 下`
          : '已恢复默认：之后新建的 worktree 放在仓库同级目录',
      });
    } else if (result.code !== 'canceled') {
      setStatus({ tone: 'error', text: result.error });
    }
  };

  return (
    <div className="grid gap-8">
      <section>
        <SectionHeader title="Worktree 位置">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || info === null || info.isDefault}
            onClick={() => void choose({ reset: true })}
          >
            <RotateCcw />
            恢复默认
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void choose()}>
            <FolderOpen />
            选择目录…
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
        <SectionHeader title="磁盘占用">
          <Button
            size="sm"
            variant="outline"
            disabled={measuring || info === null}
            onClick={() => void refresh({ measure: true })}
          >
            <RefreshCw className={cn(measuring && 'animate-spin')} />
            重新统计
          </Button>
        </SectionHeader>
        {error && (
          <InlineMessage tone="error" className="mb-3 break-all">
            {error}
          </InlineMessage>
        )}
        {info === null ? null : info.workspaces.length === 0 ? (
          <EmptyState icon={FolderTree} title="还没有挂入工作区" />
        ) : (
          <ul className="divide-y rounded-lg border">
            {info.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.workspaceId}
                workspace={workspace}
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

// --- sessions ---
const ARCHIVE_IDLE_ITEMS = ARCHIVE_IDLE_DAYS.map((days) => ({
  value: String(days),
  label: days === 0 ? '关闭' : `${days} 天`,
}));
const DELETE_ARCHIVED_ITEMS = DELETE_ARCHIVED_DAYS.map((days) => ({
  value: String(days),
  label: days === 0 ? '永不' : `${days} 天`,
}));

function SessionsSection() {
  const sessions = useGeneralPreferencesStore((state) => state.sessions);
  const update = useGeneralPreferencesStore((state) => state.update);
  const error = useGeneralPreferencesStore((state) => state.error);
  return (
    <section>
      <SectionHeader title="会话" />
      <ul className="divide-y rounded-lg border">
        <PreferenceRow label="归档闲置会话" hint="超过天数没有更新的会话移入已归档">
          {(id) => (
            <DaysSelect
              id={id}
              items={ARCHIVE_IDLE_ITEMS}
              value={sessions.archiveIdleDays}
              onChange={(days) => {
                if (isArchiveIdleDays(days)) void update({ archiveIdleDays: days });
              }}
            />
          )}
        </PreferenceRow>
        <PreferenceRow label="归档时清理 worktree" hint="只删已合并且干净的">
          {(id) => (
            <Switch
              id={id}
              aria-label="归档时清理 worktree"
              checked={sessions.cleanupWorktreeOnArchive}
              onCheckedChange={(checked) => void update({ cleanupWorktreeOnArchive: checked })}
            />
          )}
        </PreferenceRow>
        <PreferenceRow label="删除归档会话" hint="归档超过天数后删除记录，pi 会话文件保留">
          {(id) => (
            <DaysSelect
              id={id}
              items={DELETE_ARCHIVED_ITEMS}
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
const TIMELINE_ROWS: { key: keyof TimelinePreferences; label: string; hint: string }[] = [
  {
    key: 'compactReadonlyTools',
    label: '精简只读工具',
    hint: 'read / grep / find / ls 单行显示，连续的合成一条',
  },
  { key: 'autoExpandEdits', label: '运行中展开文件改动', hint: 'edit / write 的 diff 与写入内容' },
  { key: 'autoExpandThinking', label: '思考时展开', hint: '思考结束后收起' },
  { key: 'foldHistoryTurns', label: '折叠历史轮次', hint: '发送新消息后，之前的轮次折叠成一行' },
];

function TimelineSection() {
  const timeline = useGeneralPreferencesStore((state) => state.timeline);
  const update = useGeneralPreferencesStore((state) => state.update);
  return (
    <section>
      <SectionHeader title="时间线" />
      <ul className="divide-y rounded-lg border">
        {TIMELINE_ROWS.map(({ key, label, hint }) => (
          <PreferenceRow key={key} label={label} hint={hint}>
            {(id) => (
              <Switch
                id={id}
                aria-label={label}
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
  if (info === null) {
    return (
      <p className="rounded-lg border px-4 py-3 text-muted-foreground text-sm">
        {failed ? '读取失败' : '读取中…'}
      </p>
    );
  }
  // 布局一行写出来（路径或命名规则），规则与退回位置放在悬停提示里
  if (info.isDefault) {
    return (
      <div className="grid gap-1 rounded-lg border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">仓库同级目录</span>
          <Badge variant="outline">默认</Badge>
        </div>
        <p
          className="font-mono text-muted-foreground text-xs"
          title={`仓库父目录不可写时退回 ${info.fallbackRoot}`}
        >
          {'<仓库目录名>-worktrees'}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-1 rounded-lg border px-4 py-3">
      <span className="font-medium text-sm">自定义目录</span>
      <p className="break-all font-mono text-xs" title="按仓库分子目录：<根目录>/<仓库目录名>/…">
        {info.worktreesRoot}
      </p>
    </div>
  );
}

function WorkspaceRow({
  workspace,
  measuring,
}: {
  workspace: WorkspaceWorktreesInfo;
  measuring: boolean;
}) {
  const { usage } = workspace;
  const size = usage ? formatBytes(usage.bytes) : measuring ? '统计中…' : '—';
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{workspace.name}</span>
          {workspace.fallback && (
            <Badge variant="outline" title={workspace.fallback}>
              已退回数据目录
            </Badge>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={workspace.root}>
          新建：{workspace.root}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn('font-medium text-sm tabular-nums', !usage && 'text-muted-foreground')}>
          {size}
        </p>
        <p className="text-muted-foreground text-xs">
          {workspace.count} 个 worktree
          {usage && usage.missing > 0 ? `，${usage.missing} 个目录已不存在` : ''}
        </p>
      </div>
    </li>
  );
}
