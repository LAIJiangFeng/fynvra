import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ORCHESTRATOR_ROLE_ID, type Role } from '@fynvra/core';
import { Crown, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import { useRolesStore } from '@/stores/roles';
import { useSessionsStore } from '@/stores/sessions';
import { pickRole } from './roleChoices';
import { isOrchestratorRole, useRoles } from './roles';

/**
 * 「新建会话」：弹层里从角色库（设置 → 角色，含自定义角色）选角色，在当前工作区创建并选中。
 * 每次打开默认选 orchestrator 并重读角色库。`compact` 用于侧栏的小图标按钮。
 */
export function NewSessionButton({ compact = false }: { compact?: boolean }) {
  const roles = useRoles();
  // 角色库是空的又读取失败时，列表里只有退回的内置角色：告诉用户原因
  const loadError = useRolesStore((state) => (state.roles.length === 0 ? state.error : null));
  const refreshRoles = useRolesStore((state) => state.refresh);
  const createSession = useSessionsStore((state) => state.createSession);
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState<string>(ORCHESTRATOR_ROLE_ID);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = pickRole(roles, roleId);

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
        if (!next) return;
        setError(null);
        setRoleId(ORCHESTRATOR_ROLE_ID);
        void refreshRoles();
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
        <div className="min-w-0 space-y-2">
          <RadioGroup
            aria-label="角色"
            value={selected?.id ?? ''}
            onValueChange={(value) => {
              if (typeof value === 'string') setRoleId(value);
            }}
            className="-mx-1 grid max-h-[min(22rem,55vh)] gap-1.5 overflow-y-auto px-1 py-1"
          >
            {roles.map((role) => (
              <RoleOption
                key={role.id}
                role={role}
                orchestrator={isOrchestratorRole(role.id, roles)}
              />
            ))}
          </RadioGroup>
          {loadError && (
            <p className="text-muted-foreground text-xs">
              角色列表读取失败，先显示内置角色（{loadError}）
            </p>
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

/** 一个可选角色：名称（主 agent 带皇冠）、内置徽标、描述。 */
function RoleOption({ role, orchestrator }: { role: Role; orchestrator: boolean }) {
  return (
    <Radio.Root
      value={role.id}
      className="group flex cursor-default select-none items-start gap-3 rounded-md border px-3 py-2.5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[checked]:border-primary/60 data-[checked]:bg-accent"
    >
      <span
        aria-hidden
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-[checked]:border-primary"
      >
        <Radio.Indicator className="size-2 rounded-full bg-primary" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {orchestrator && (
            <Crown aria-hidden className="size-3.5 shrink-0 text-violet-600 dark:text-violet-300" />
          )}
          <span className="truncate font-medium text-sm">{role.name}</span>
          {role.builtin && <Badge variant="outline">内置</Badge>}
        </span>
        <span
          className={cn(
            'mt-0.5 line-clamp-2 text-muted-foreground text-xs',
            !role.description && 'italic opacity-70'
          )}
        >
          {role.description || '没有描述'}
        </span>
      </span>
    </Radio.Root>
  );
}
