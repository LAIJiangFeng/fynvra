import type { McpServerEntryView } from '@shared/types/llm';
import { HardDriveDownload, KeyRound, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useMcpStore } from '@/stores/mcp';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { McpDialog, type McpEditing, TRANSPORT_LABELS } from './McpDialog';
import { McpImportDialog } from './McpImportDialog';
import { draftFromServer, emptyMcpDraft, type McpDraft } from './mcpForm';

type Status = { tone: 'error' | 'success'; text: string };

export function McpSettings() {
  const servers = useMcpStore((state) => state.servers);
  const loaded = useMcpStore((state) => state.loaded);
  const error = useMcpStore((state) => state.error);
  const [editing, setEditing] = useState<McpEditing | null>(null);
  const [importSession, setImportSession] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const sessions = useRef(0);

  const edit = (draft: McpDraft) => {
    sessions.current += 1;
    setEditing({ key: sessions.current, draft });
  };

  const openImport = () => {
    sessions.current += 1;
    setStatus(null);
    setImportSession(sessions.current);
  };

  return (
    <section>
      <SectionHeader
        title="MCP 服务器"
        description="角色从这里挑选 MCP 服务器。环境变量与 Header 的值只保存在本机，界面上只显示键名。"
      >
        <Button size="sm" variant="outline" onClick={openImport}>
          <HardDriveDownload />
          从本机导入…
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
          description="手动添加，或从本机的 Claude Code、Codex、Grok CLI、Gemini CLI、Cursor、VS Code、OpenCode、CC Switch 导入（按命令 + 参数 / URL 去重）。"
        >
          <Button size="sm" variant="outline" onClick={openImport}>
            <HardDriveDownload />
            从本机导入
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
      <McpImportDialog
        session={importSession}
        onClose={() => setImportSession(null)}
        onImported={setStatus}
      />
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
