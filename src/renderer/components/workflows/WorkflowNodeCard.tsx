import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { NODE_HEIGHT, NODE_WIDTH } from './layout';

/** 节点运行状态（W4 任务进度图用）：等待 / 运行中 / 通过 / 失败 / 取消。 */
export type WorkflowNodeStatus = 'waiting' | 'running' | 'passed' | 'failed' | 'cancelled';

export type WorkflowNodeData = {
  name: string;
  roleLabel: string;
  /** 引用的角色不存在或不可执行 */
  roleWarning: boolean;
  /** 说明首行 */
  summary: string;
  /** 失败退回标记：title 为悬停说明；退回自身时 badge 为显示在卡片上的短文字（没有连线可画） */
  failBack?: { title: string; badge?: string };
  status?: WorkflowNodeStatus;
  statusLabel?: string;
  editable: boolean;
};

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflowStep'>;

const STATUS_STYLE: Record<WorkflowNodeStatus, { card: string; icon: string }> = {
  waiting: { card: '', icon: 'text-muted-foreground' },
  running: { card: 'border-sky-500 dark:border-sky-400', icon: 'text-sky-600 dark:text-sky-400' },
  passed: {
    card: 'border-emerald-500 dark:border-emerald-400',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  failed: { card: 'border-destructive', icon: 'text-destructive' },
  cancelled: { card: 'border-dashed opacity-70', icon: 'text-muted-foreground' },
};

const STATUS_ICON = {
  waiting: CircleDashed,
  running: LoaderCircle,
  passed: CircleCheck,
  failed: CircleX,
  cancelled: Ban,
} as const;

/** 隐藏的连接点：失败退回边的挂靠点、只读模式下的出入口，都不能手动连线。 */
const HIDDEN_HANDLE = { opacity: 0, pointerEvents: 'none' } as const;

function WorkflowNodeCardImpl({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const status = data.status;
  const StatusIcon = status ? STATUS_ICON[status] : null;
  return (
    <div
      className={cn(
        'flex flex-col justify-center gap-0.5 rounded-lg border-2 bg-card px-3 py-2 text-card-foreground shadow-xs',
        status && STATUS_STYLE[status].card,
        selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        isConnectable={data.editable}
        style={data.editable ? undefined : HIDDEN_HANDLE}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        isConnectable={data.editable}
        style={data.editable ? undefined : HIDDEN_HANDLE}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="fail-out"
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="fail-in"
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        {StatusIcon && status && (
          <span title={data.statusLabel} className="shrink-0">
            <StatusIcon
              aria-label={data.statusLabel}
              className={cn(
                'size-4',
                STATUS_STYLE[status].icon,
                status === 'running' && 'animate-spin'
              )}
            />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{data.name}</span>
        {data.failBack && (
          <span
            title={data.failBack.title}
            className="flex shrink-0 items-center gap-0.5 text-destructive text-xs"
          >
            <RotateCcw aria-label={data.failBack.title} className="size-3.5" />
            {data.failBack.badge && <span>{data.failBack.badge}</span>}
          </span>
        )}
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center gap-1 text-xs',
          data.roleWarning ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
        )}
      >
        {data.roleWarning ? (
          <TriangleAlert className="size-3 shrink-0" />
        ) : (
          <UserRound className="size-3 shrink-0" />
        )}
        <span className="truncate">{data.roleLabel}</span>
      </div>
      {data.summary && <p className="truncate text-muted-foreground text-xs">{data.summary}</p>}
    </div>
  );
}

export const WorkflowNodeCard = memo(WorkflowNodeCardImpl);
