import type { Role } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { FileUp, Plus, UserCog } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRolesStore } from '@/stores/roles';
import { EmptyState, InlineMessage } from './common';
import { RoleEditor } from './RoleEditor';
import { copyRole, newRole, parseRoleImport } from './roleTransfer';

type Status = { tone: 'error' | 'success'; text: string };

/** 编辑目标：已有角色按 id；新建 / 复制出来的草稿还没落盘。key 变化时编辑器重置。 */
type Editing = { kind: 'existing'; id: string } | { kind: 'draft'; key: number; role: Role };

export function RolesSettings() {
  const roles = useRolesStore((state) => state.roles);
  const loaded = useRolesStore((state) => state.loaded);
  const error = useRolesStore((state) => state.error);
  const save = useRolesStore((state) => state.save);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drafts = useRef(0);

  const takenIds = roles.map((role) => role.id);
  const fallback = roles[0];
  const target: Editing | null =
    editing ?? (fallback ? { kind: 'existing', id: fallback.id } : null);
  const selectedRole =
    target?.kind === 'existing' ? roles.find((role) => role.id === target.id) : undefined;

  /** 切换编辑目标前确认放弃未保存的修改。 */
  const go = (next: Editing) => {
    if (dirty && !window.confirm('当前角色有未保存的修改，放弃这些修改？')) return;
    setDirty(false);
    setStatus(null);
    setEditing(next);
  };
  const openDraft = (role: Role) => {
    drafts.current += 1;
    go({ kind: 'draft', key: drafts.current, role });
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch (readError) {
      setStatus({ tone: 'error', text: `读取文件失败：${errorMessage(readError)}` });
      return;
    }
    const parsed = parseRoleImport(text, takenIds);
    if (!parsed.ok) {
      setStatus({ tone: 'error', text: parsed.error });
      return;
    }
    const failures: string[] = [];
    for (const role of parsed.roles) {
      const result = await save(role);
      if (!result.ok) failures.push(`${role.id}：${result.error}`);
    }
    const imported = parsed.roles.length - failures.length;
    const renamed = parsed.renamed > 0 ? `，其中 ${parsed.renamed} 个因 id 冲突已改名` : '';
    setStatus(
      failures.length > 0
        ? {
            tone: 'error',
            text: `导入 ${imported} 个，失败 ${failures.length} 个：${failures.join('；')}`,
          }
        : { tone: 'success', text: `已导入 ${imported} 个角色${renamed}` }
    );
    const first = parsed.roles[0];
    if (imported > 0 && first && !dirty) setEditing({ kind: 'existing', id: first.id });
  };

  if (loaded && roles.length === 0) {
    return <EmptyState icon={UserCog} title="读取角色失败" description={error ?? undefined} />;
  }

  return (
    <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="grid content-start gap-3">
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" onClick={() => openDraft(newRole(takenIds))}>
            <Plus />
            新建
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => fileInput.current?.click()}
          >
            <FileUp />
            导入
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => void importFile(event)}
          />
        </div>
        <ul className="grid gap-0.5">
          {target?.kind === 'draft' && (
            <li>
              <RoleListItem title={target.role.name || '新角色'} subtitle="未保存" active />
            </li>
          )}
          {roles.map((role) => (
            <li key={role.id}>
              <RoleListItem
                title={role.name}
                subtitle={role.id}
                builtin={role.builtin}
                active={target?.kind === 'existing' && target.id === role.id}
                onSelect={() => go({ kind: 'existing', id: role.id })}
              />
            </li>
          ))}
        </ul>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
      </aside>

      <div className="min-w-0">
        {status && (
          <InlineMessage tone={status.tone} className="mb-4 break-all">
            {status.text}
          </InlineMessage>
        )}
        {target?.kind === 'draft' && (
          <RoleEditor
            key={`draft-${target.key}`}
            initial={target.role}
            isNew
            takenIds={takenIds}
            onDirtyChange={setDirty}
            onSaved={(role) => {
              setDirty(false);
              setStatus({ tone: 'success', text: `已保存到 roles/${role.id}.json` });
              setEditing({ kind: 'existing', id: role.id });
            }}
            onCopy={openDraft}
            onRemoved={() => setEditing(null)}
          />
        )}
        {selectedRole && (
          <RoleEditor
            key={`role-${selectedRole.id}-${JSON.stringify(selectedRole)}`}
            initial={selectedRole}
            isNew={false}
            takenIds={takenIds}
            onDirtyChange={setDirty}
            onSaved={() => {
              setDirty(false);
              setStatus({ tone: 'success', text: `已保存到 roles/${selectedRole.id}.json` });
            }}
            onCopy={(role) => openDraft(copyRole(role, takenIds))}
            onRemoved={() => {
              setDirty(false);
              setStatus({ tone: 'success', text: `已删除 ${selectedRole.name}` });
              setEditing(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function RoleListItem({
  title,
  subtitle,
  builtin,
  active,
  onSelect,
}: {
  title: string;
  subtitle: string;
  builtin?: boolean;
  active: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-accent text-accent-foreground'
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">{title}</span>
        <span className="block truncate font-mono text-muted-foreground text-xs">{subtitle}</span>
      </span>
      {builtin && <Badge variant="outline">内置</Badge>}
    </button>
  );
}
