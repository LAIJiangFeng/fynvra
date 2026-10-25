import type { WorkspaceWorktreesInfo, WorktreesRootInfo } from '@shared/types/settings';
import { FolderOpen, FolderTree, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useWorktreesRootStore } from '@/stores/settings';
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

/** 通用：worktree 放在哪（Main 弹框选择并校验，Renderer 不传路径），以及各工作区登记的 worktree 占用。 */
export function GeneralSettings() {
  const info = useWorktreesRootStore((state) => state.info);
  const measuring = useWorktreesRootStore((state) => state.measuring);
  const error = useWorktreesRootStore((state) => state.error);
  const refresh = useWorktreesRootStore((state) => state.refresh);
  const pick = useWorktreesRootStore((state) => state.pick);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
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
                plain={workspaces.some(
                  (candidate) => candidate.id === workspace.workspaceId && candidate.vcs === 'none'
                )}
                measuring={measuring}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
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
  plain,
  measuring,
}: {
  workspace: WorkspaceWorktreesInfo;
  /** 无 git 的工作区不建 worktree，不给位置与占用 */
  plain: boolean;
  measuring: boolean;
}) {
  if (plain) {
    return (
      <li className="flex items-center gap-2 px-4 py-3">
        <span className="font-medium text-sm">{workspace.name}</span>
        <Badge variant="outline" title="不会使用 worktree">
          无 git
        </Badge>
      </li>
    );
  }
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
