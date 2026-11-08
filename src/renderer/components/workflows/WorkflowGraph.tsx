import '@xyflow/react/dist/style.css';
import type { WorkflowPosition, WorkflowStep } from '@fynvra/core';
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MarkerType,
  type NodeChange,
  type OnBeforeDelete,
  type OnConnectEnd,
  type OnConnectStart,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { LayoutGrid, Trash2 } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { autoLayout, clampPosition, NODE_HEIGHT, NODE_WIDTH, resolvePositions } from './layout';
import {
  type WorkflowFlowNode,
  WorkflowNodeCard,
  type WorkflowNodeData,
  type WorkflowNodeStatus,
} from './WorkflowNodeCard';

export type { WorkflowNodeStatus } from './WorkflowNodeCard';

/** 画布上的一条边：依赖边 source = 上游、target = 下游；失败退回边 source = 失败节点、target = 退回目标。 */
export interface WorkflowEdgeRef {
  kind: 'needs' | 'fail';
  source: string;
  target: string;
}

export interface WorkflowGraphProps {
  /** 节点（WorkflowStep）；有 position 用它，缺失时 dagre 从左到右自动排版 */
  steps: readonly WorkflowStep[];
  /** 角色 id → 显示名；不在表里的角色按「不存在」标警告 */
  roleNames: Readonly<Record<string, string>>;
  /** 可选的角色 id 集合：在 roleNames 里但不能执行节点（如编排角色）的也标警告 */
  invalidRoleIds?: ReadonlySet<string>;
  /** 节点状态（只读进度图）：按状态着色并显示图标 */
  statuses?: Readonly<Partial<Record<string, WorkflowNodeStatus>>>;
  /** 可编辑：拖动、连线、删除、自动排版；默认只读 */
  editable?: boolean;
  /** 受控的选中节点 */
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** 点击节点（只读模式也会触发，W4 用来查看 worker 输出） */
  onNodeClick?: (id: string) => void;
  /** 鼠标移入节点时为节点 id，移出时为 null（W4 用来显示节点详情） */
  onNodeHover?: (id: string | null) => void;
  /** 拖动结束或自动排版：新的坐标（已取整、限制在模型范围内） */
  onMove?: (positions: Record<string, WorkflowPosition>) => void;
  /** 从 source 的出口拉线到 target 的入口；是否接受由调用方判断 */
  onConnect?: (source: string, target: string) => void;
  /** 删除请求（Delete 键或「删除所选」）；画布本身不删，由调用方更新 steps */
  onDelete?: (request: { nodeIds: string[]; edges: WorkflowEdgeRef[] }) => void;
  /** 编辑模式工具栏里额外的按钮（放在左上角） */
  toolbar?: ReactNode;
  className?: string;
}

const NODE_TYPES = { workflowStep: WorkflowNodeCard };
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1 };
const PRO_OPTIONS = { hideAttribution: true };
const DELETE_KEYS = ['Delete', 'Backspace'];
/** 拖出连线时，离入口圆点多远（屏幕像素）就吸附过去 */
const CONNECTION_RADIUS = 50;

/** 说明首行（去掉空白行），卡片上截断显示。 */
function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

function edgeRefOf(edge: Edge): WorkflowEdgeRef | undefined {
  const kind = edge.data?.kind;
  return kind === 'needs' || kind === 'fail'
    ? { kind, source: edge.source, target: edge.target }
    : undefined;
}

/**
 * 工作流流程图：节点卡片显示名称、执行角色、说明首行；依赖是从上游指向下游的实线箭头，
 * 失败退回是从节点指向退回目标的红色虚线（退回自身时在卡片上标「重做」）。
 * 只读模式可传 statuses 按节点状态着色（W4 任务进度图）。
 */
export function WorkflowGraph(props: WorkflowGraphProps) {
  return (
    <ReactFlowProvider>
      <WorkflowGraphInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowGraphInner({
  steps,
  roleNames,
  invalidRoleIds,
  statuses,
  editable = false,
  selectedId = null,
  onSelect,
  onNodeClick,
  onNodeHover,
  onMove,
  onConnect,
  onDelete,
  toolbar,
  className,
}: WorkflowGraphProps) {
  const t = useT();
  const flow = useReactFlow<WorkflowFlowNode>();

  const positions = useMemo(() => resolvePositions(steps), [steps]);

  const derivedNodes = useMemo<WorkflowFlowNode[]>(() => {
    const names = new Map(steps.map((step) => [step.id, step.name]));
    return steps.map((step) => {
      const roleName = roleNames[step.roleId];
      const status = statuses?.[step.id];
      const failTarget = step.onFail ? names.get(step.onFail) : undefined;
      const data: WorkflowNodeData = {
        name: step.name.trim() || t('settings.workflows.graph.untitled'),
        roleLabel: roleName ?? step.roleId,
        roleWarning: roleName === undefined || (invalidRoleIds?.has(step.roleId) ?? false),
        summary: firstLine(step.instructions),
        ...(step.onFail
          ? {
              failBack:
                step.onFail === step.id
                  ? {
                      title: t('settings.workflows.graph.failSelfTitle'),
                      badge: t('settings.workflows.graph.failSelf'),
                    }
                  : {
                      title: t('settings.workflows.graph.failBackTo', {
                        name: failTarget ?? step.onFail,
                      }),
                    },
            }
          : {}),
        ...(status ? { status, statusLabel: t(`settings.workflows.graph.status.${status}`) } : {}),
        editable,
      };
      return {
        id: step.id,
        type: 'workflowStep',
        position: positions[step.id] ?? { x: 0, y: 0 },
        data,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        selected: step.id === selectedId,
        draggable: editable,
        connectable: editable,
        deletable: editable,
      };
    });
  }, [steps, positions, roleNames, invalidRoleIds, statuses, editable, selectedId, t]);

  const derivedEdges = useMemo<Edge[]>(() => {
    const ids = new Set(steps.map((step) => step.id));
    const edges: Edge[] = [];
    for (const step of steps) {
      for (const need of step.needs) {
        if (!ids.has(need)) continue;
        edges.push({
          id: `needs:${need}->${step.id}`,
          source: need,
          target: step.id,
          sourceHandle: 'out',
          targetHandle: 'in',
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)' },
          deletable: editable,
          data: { kind: 'needs' },
        });
      }
      if (step.onFail && step.onFail !== step.id && ids.has(step.onFail)) {
        edges.push({
          id: `fail:${step.id}->${step.onFail}`,
          source: step.id,
          target: step.onFail,
          sourceHandle: 'fail-out',
          targetHandle: 'fail-in',
          type: 'smoothstep',
          className: 'workflow-fail-edge',
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--destructive)' },
          label: t('settings.workflows.graph.failBack'),
          labelStyle: { fill: 'var(--destructive)', fontSize: 11 },
          labelBgStyle: { fill: 'var(--card)' },
          labelBgPadding: [4, 2],
          labelBgBorderRadius: 4,
          deletable: editable,
          zIndex: 1,
          data: { kind: 'fail' },
        });
      }
    }
    return edges;
  }, [steps, editable, t]);

  // React Flow 需要本地节点 / 边状态来承载拖动中的位置、尺寸测量与边的选中；
  // 输入变化时以输入为准重建，只保留测量结果（丢掉会导致连接点失效）与边的选中态。
  const [nodes, setNodes] = useState<WorkflowFlowNode[]>(derivedNodes);
  const [edges, setEdges] = useState<Edge[]>(derivedEdges);
  useEffect(() => {
    setNodes((previous) => {
      const measured = new Map(previous.map((node) => [node.id, node.measured]));
      return derivedNodes.map((node) => {
        const size = measured.get(node.id);
        return size ? { ...node, measured: size } : node;
      });
    });
  }, [derivedNodes]);
  useEffect(() => {
    setEdges((previous) => {
      const selected = new Set(previous.filter((edge) => edge.selected).map((edge) => edge.id));
      return derivedEdges.map((edge) =>
        selected.has(edge.id) ? { ...edge, selected: true } : edge
      );
    });
  }, [derivedEdges]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) =>
      setNodes((current) => applyNodeChanges(changes, current)),
    []
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)),
    []
  );

  const handleSelection = useCallback<OnSelectionChangeFunc<WorkflowFlowNode>>(
    ({ nodes: picked }) => onSelect?.(picked[0]?.id ?? null),
    [onSelect]
  );

  const handleDragStop = useCallback<OnNodeDrag<WorkflowFlowNode>>(
    (_event, _node, dragged) => {
      onMove?.(Object.fromEntries(dragged.map((node) => [node.id, clampPosition(node.position)])));
    },
    [onMove]
  );

  const handleConnect = useCallback(
    (connection: Connection) => onConnect?.(connection.source, connection.target),
    [onConnect]
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // 正在从哪个节点的出口拉线：画布据此高亮可落点的入口和鼠标下的目标卡片
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);

  const handleConnectStart = useCallback<OnConnectStart>(
    (_event, { nodeId, handleId, handleType }) => {
      setConnectingFrom(handleType === 'source' && handleId === 'out' ? nodeId : null);
    },
    []
  );

  // 没对准入口圆点时：松手落在另一张节点卡片的任意位置也算连到它，
  // 仍走同一个 onConnect，自连 / 重复 / 成环由调用方照常校验。
  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, state) => {
      setConnectingFrom(null);
      if (state.isValid) return; // 已由 onConnect 处理
      const from = state.fromHandle;
      if (from?.type !== 'source' || from.id !== 'out') return;
      if (!('clientX' in event)) return; // 触屏：忽略
      const container = containerRef.current;
      if (!container) return;
      for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
        if (!container.contains(element)) continue;
        if (element.closest('.react-flow__panel')) return; // 落在工具栏 / 缩放控件上
        const nodeElement = element.closest<HTMLElement>('.react-flow__node');
        if (!nodeElement) continue;
        const target = nodeElement.dataset.id;
        if (!target) return;
        // 松手仍在自己的出口圆点上：视为放弃，不报自连
        if (target === from.nodeId && element.closest('.react-flow__handle')) return;
        onConnect?.(from.nodeId, target);
        return;
      }
    },
    [onConnect]
  );

  const flowNodes = useMemo(
    () =>
      connectingFrom
        ? nodes.map((node) =>
            node.id === connectingFrom ? { ...node, className: 'workflow-connect-source' } : node
          )
        : nodes,
    [nodes, connectingFrom]
  );
  const explicitDelete = useRef(false);

  // 删除一律交给调用方（确认、清理引用），画布自己不删。
  // React Flow 的 Delete / Backspace 监听在 document 上：只在焦点位于画布内时生效，
  // 避免焦点在侧栏控件上时误删画布里选中的元素；「删除所选」按钮走显式路径。
  const handleBeforeDelete = useCallback<OnBeforeDelete<WorkflowFlowNode>>(
    async ({ nodes: removedNodes, edges: removedEdges }) => {
      const explicit = explicitDelete.current;
      explicitDelete.current = false;
      if (!explicit && !containerRef.current?.contains(document.activeElement)) return false;
      const refs = removedEdges.map(edgeRefOf).filter((ref) => ref !== undefined);
      if (removedNodes.length > 0 || refs.length > 0) {
        onDelete?.({ nodeIds: removedNodes.map((node) => node.id), edges: refs });
      }
      return false;
    },
    [onDelete]
  );

  const arrange = () => {
    onMove?.(autoLayout(steps));
    // 等新坐标渲染后再适配视图
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => void flow.fitView({ ...FIT_VIEW_OPTIONS, duration: 200 }))
    );
  };

  const hasSelection = nodes.some((node) => node.selected) || edges.some((edge) => edge.selected);
  const deleteSelected = () => {
    explicitDelete.current = true;
    void flow
      .deleteElements({
        nodes: nodes.filter((node) => node.selected),
        edges: edges.filter((edge) => edge.selected),
      })
      .finally(() => {
        explicitDelete.current = false;
      });
  };

  // 焦点在画布内按 Esc：有选中时只取消选中，不再冒泡（设置页会把 Esc 当成关闭）
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !editable || !hasSelection) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.stopPropagation();
    setNodes((current) =>
      current.map((node) => (node.selected ? { ...node, selected: false } : node))
    );
    setEdges((current) =>
      current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge))
    );
    onSelect?.(null);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 只拦截画布内冒泡上来的 Esc
    <div
      ref={containerRef}
      className={cn('h-full w-full', connectingFrom && 'workflow-connecting', className)}
      onKeyDown={handleKeyDown}
    >
      <ReactFlow<WorkflowFlowNode>
        nodes={flowNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onSelectionChange={editable ? handleSelection : undefined}
        onNodeClick={onNodeClick ? (_event, node) => onNodeClick(node.id) : undefined}
        onNodeMouseEnter={onNodeHover ? (_event, node) => onNodeHover(node.id) : undefined}
        onNodeMouseLeave={onNodeHover ? () => onNodeHover(null) : undefined}
        onNodeDragStop={editable ? handleDragStop : undefined}
        onConnect={editable ? handleConnect : undefined}
        onConnectStart={editable ? handleConnectStart : undefined}
        onConnectEnd={editable ? handleConnectEnd : undefined}
        connectionRadius={CONNECTION_RADIUS}
        onBeforeDelete={handleBeforeDelete}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable={editable}
        edgesFocusable={editable}
        deleteKeyCode={editable ? DELETE_KEYS : null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        // 只读图嵌在可滚动的面板里：滚轮留给外层滚动，缩放用 Controls 或捏合
        {...(editable ? {} : { zoomOnScroll: false, panOnScroll: false, preventScrolling: false })}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.25}
        maxZoom={1.5}
        proOptions={PRO_OPTIONS}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} />
        {editable && (
          <Panel position="top-left" className="flex flex-wrap items-center gap-1.5">
            {toolbar}
            <Button type="button" size="sm" variant="outline" className="bg-card" onClick={arrange}>
              <LayoutGrid />
              {t('settings.workflows.graph.autoLayout')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-card"
              disabled={!hasSelection}
              onClick={deleteSelected}
            >
              <Trash2 />
              {t('settings.workflows.graph.deleteSelected')}
            </Button>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}
