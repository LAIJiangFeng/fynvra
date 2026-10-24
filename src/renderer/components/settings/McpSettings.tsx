import type { McpServerEntryView } from '@shared/types/llm';
import { HardDriveDownload, KeyRound, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useMcpStore } from '@/stores/mcp';
import type { McpImportResult } from '../../../preload/domains/mcp';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { McpDialog, type McpEditing, TRANSPORT_LABELS } from './McpDialog';
import { draftFromServer, emptyMcpDraft, type McpDraft } from './mcpForm';

type Status = { tone: 'error' | 'success'; text: string };

/** 导入结果 → 一句话：新增了谁、跳过几个、哪个文件读失败。 */
function describeImport(result: Extract<McpImportResult, { ok: true }>): Status {
  const failed = result.sources.filter((source) => source.status === 'error');
  const found = result.sources.some((source) => source.status === 'found');
  const parts: string[] = [];
  if (!found && failed.length === 0) {
    parts.push('没有找到 Claude Code 配置（~/.claude.json、~/.claude/settings.json）');
  } else if (result.added.length > 0) {
    parts.push(`已导入 ${result.added.length} 个：${result.added.map((s) => s.name).join('、')}`);
  } else {
    parts.push('没有新的服务器可导入');
  }
  if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个重复`);
  for (const source of failed)
    parts.push(`读取 ${source.file} 失败：${source.error ?? '未知错误'}`);
  return {
    tone: failed.length > 0 && result.added.length === 0 ? 'error' : 'success',
    text: parts.join('；'),
  };
}

export function McpSettings() {
  const servers = useMcpStore((state) => state.servers);
  const loaded = useMcpStore((state) => state.loaded);
  const error = useMcpStore((state) => state.error);
  const importClaude = useMcpStore((state) => state.importClaude);
  const [editing, setEditing] = useState<McpEditing | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [importing, setImporting] = useState(false);
  const sessions = useRef(0);

  const edit = (draft: McpDraft) => {
    sessions.current += 1;
    setEditing({ key: sessions.current, draft });
  };

  const runImport = async () => {
    setImporting(true);
    const result = await importClaude();
    setImporting(false);
    setStatus(result.ok ? describeImport(result) : { tone: 'error', text: result.error });
  };

  return (
    <section>
      <SectionHeader
        title="MCP 服务器"
        description="角色从这里挑选 MCP 服务器。环境变量与 Header 的值只保存在本机，界面上只显示键名。"
      >
        <Button size="sm" variant="outline" disabled={importing} onClick={() => void runImport()}>
          <HardDriveDownload />从 Claude Code 导入
        </Button>
        <Button size="sm" onClick={() => edit(emptyMcpDraft())}>
          <Plus />
          添加服务器
        </Button>
      </SectionHeader>

      {status && (
        <InlineMessage tone={status.tone} className="mb-3 break-all">
          {status.text}
        </InlineMessage>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      {loaded && servers.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="还没有 MCP 服务器"
          description="手动添加，或导入本机 Claude Code 的配置（按命令+参数 / URL 去重）。"
        >
          <Button size="sm" variant="outline" disabled={importing} onClick={() => void runImport()}>
            <HardDriveDownload />从 Claude Code 导入
          </Button>
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border">
          {servers.map((server) => (
            <McpRow
              key={server.id}
              server={server}
              onEdit={() => edit(draftFromServer(server))}
              onError={(text) => setStatus({ tone: 'error', text })}
            />
          ))}
        </ul>
      )}

      <McpDialog editing={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function McpRow({
  server,
  onEdit,
  onError,
}: {
  server: McpServerEntryView;
  onEdit: () => void;
  onError: (message: string) => void;
}) {
  const toggle = useMcpStore((state) => state.toggle);
  const remove = useMcpStore((state) => state.remove);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const summary = server.url ?? [server.command, ...(server.args ?? [])].join(' ');
  const secretKeys = [...server.envKeys, ...server.headerKeys];

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{server.name}</span>
          <Badge variant="outline">{TRANSPORT_LABELS[server.transport]}</Badge>
          {!server.enabled && <Badge>已停用</Badge>}
        </div>
        <p className="truncate font-mono text-muted-foreground text-xs" title={summary}>
          {summary}
        </p>
        {secretKeys.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {secretKeys.map((key) => (
              <Badge
                key={key}
                variant="outline"
                className="font-mono"
                title="值已保存在本机，不在界面显示"
              >
                <KeyRound />
                {key}
              </Badge>
            ))}
          </div>
        )}
        {confirmingRemove && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-muted-foreground text-xs">删除后引用它的角色将不再加载它。</span>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                const result = await remove(server.id);
                if (!result.ok) {
                  setConfirmingRemove(false);
                  onError(result.error);
                }
              }}
            >
              确认删除
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
              取消
            </Button>
          </div>
        )}
      </div>
      <Switch
        className="mt-1"
        checked={server.enabled}
        aria-label={`启用 ${server.name}`}
        onCheckedChange={async (enabled) => {
          const result = await toggle(server.id, enabled);
          if (!result.ok) onError(result.error);
        }}
      />
      <Button variant="ghost" size="icon-xs" aria-label={`编辑 ${server.name}`} onClick={onEdit}>
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`删除 ${server.name}`}
        className="text-destructive hover:text-destructive"
        onClick={() => setConfirmingRemove(true)}
      >
        <Trash2 />
      </Button>
    </li>
  );
}
