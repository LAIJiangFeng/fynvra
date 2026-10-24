import { ORCHESTRATOR_ROLE_ID } from '@fynvra/core';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSessionsStore } from '@/stores/sessions';
import { useRoles } from './roles';
import { RoleBadge } from './SessionBadges';

/** 「新建会话」：弹层里选角色后在当前工作区创建并选中。`compact` 用于侧栏的小图标按钮。 */
export function NewSessionButton({ compact = false }: { compact?: boolean }) {
  const roles = useRoles();
  const createSession = useSessionsStore((state) => state.createSession);
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState<string>(ORCHESTRATOR_ROLE_ID);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = roles.map((role) => ({ value: role.id, label: role.name }));
  const selected = roles.find((role) => role.id === roleId) ?? roles[0];

  const submit = async () => {
    if (!selected) return;
    setCreating(true);
    setError(null);
    const result = await createSession(selected.id);
    setCreating(false);
    if (result.ok) setOpen(false);
    else setError(result.error);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger
        render={
          compact ? (
            <Button variant="ghost" size="icon-xs" aria-label="新建会话" title="新建会话" />
          ) : (
            <Button />
          )
        }
      >
        <Plus />
        {!compact && '新建会话'}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
          <DialogDescription>
            选择会话使用的角色。主 agent 负责拆任务、派 worker、验收合并，自己不改代码。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select
            items={items}
            value={selected?.id ?? ''}
            onValueChange={(value) => {
              if (typeof value === 'string') setRoleId(value);
            }}
          >
            <SelectTrigger aria-label="角色">
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
          {selected && (
            <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
              <RoleBadge roleId={selected.id} className="mt-0.5" />
              <span className="text-muted-foreground">{selected.description || '没有描述'}</span>
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
          <Button disabled={creating || !selected} onClick={() => void submit()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
