import type { McpServerEntryView } from '@shared/types/llm';
import { HardDriveDownload, KeyRound, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { useMcpStore } from '@/stores/mcp';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { McpDialog, type McpEditing } from './McpDialog';
import { McpImportDialog } from './McpImportDialog';
import { draftFromServer, emptyMcpDraft, type McpDraft } from './mcpForm';
import { maskSecrets } from './secretMask';

type Status = { tone: 'error' | 'success'; text: string };

export function McpSettings() {
  const servers = useMcpStore((state) => state.servers);
  const loaded = useMcpStore((state) => state.loaded);
  const error = useMcpStore((state) => state.error);
  const [editing, setEditing] = useState<McpEditing | null>(null);
  const [importSession, setImportSession] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const sessions = useRef(0);
  const t = useT();

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
      <SectionHeader title={t('settings.mcp.title')}>
        <Button size="sm" variant="outline" onClick={openImport}>
          <HardDriveDownload />
          {t('settings.import.fromLocal')}
        </Button>
        <Button size="sm" onClick={() => edit(emptyMcpDraft())}>
          <Plus />
          {t('settings.mcp.add')}
        </Button>
      </SectionHeader>

      {status && (
        <InlineMessage tone={status.tone} className="mb-3 break-all">
          {status.text}
        </InlineMessage>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      {loaded && servers.length === 0 ? (
        <EmptyState icon={Plug} title={t('settings.mcp.empty')}>
          <Button size="sm" variant="outline" onClick={openImport}>
            <HardDriveDownload />
            {t('settings.import.fromLocalShort')}
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
  const t = useT();
  // 参数、URL 里的密钥打码显示；编辑弹窗里仍是原值
  const summary = maskSecrets(server.url ?? [server.command, ...(server.args ?? [])].join(' '));
  const secretKeys = [...server.envKeys, ...server.headerKeys];

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{server.name}</span>
          <Badge variant="outline">{t(`settings.mcp.transports.${server.transport}`)}</Badge>
          {!server.enabled && <Badge>{t('common.disabled')}</Badge>}
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
                title={t('settings.mcp.keySaved')}
              >
                <KeyRound />
                {key}
              </Badge>
            ))}
          </div>
        )}
        {confirmingRemove && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t('settings.mcp.removeConsequence')}
            </span>
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
              {t('common.confirmDelete')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </div>
      <Switch
        className="mt-1"
        checked={server.enabled}
        aria-label={t('common.enableItem', { name: server.name })}
        onCheckedChange={async (enabled) => {
          const result = await toggle(server.id, enabled);
          if (!result.ok) onError(result.error);
        }}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common.editItem', { name: server.name })}
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common.deleteItem', { name: server.name })}
        className="text-destructive hover:text-destructive"
        onClick={() => setConfirmingRemove(true)}
      >
        <Trash2 />
      </Button>
    </li>
  );
}
