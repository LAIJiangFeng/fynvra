import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ORCHESTRATOR_ROLE_ID, type Role } from '@fynvra/core';
import type { SessionModelRef } from '@shared/types/chat';
import { Crown, Plus } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useActionHandler } from '@/lib/keybindings';
import { useRolesStore } from '@/stores/roles';
import { selectModelProviders, useSessionsStore } from '@/stores/sessions';
import { chooseModel, defaultModelChoice, findModel } from '@/stores/sessions/modelChoice';
import {
  ModelSelect,
  NO_PROVIDERS,
  NO_PROVIDERS_HINT,
  ThinkingLevelPicker,
  ThinkingSourceBadge,
} from './ModelPicker';
import { pickRole } from './roleChoices';
import { isOrchestratorRole, useRoles } from './roles';

/**
 * 「新建会话」：弹层里从角色库（设置 → 角色，含自定义角色）选角色，再选模型与思考档位，在当前工作区创建并选中。
 * 每次打开默认选 orchestrator 并重读角色库与可选模型。模型默认依次取角色的模型、该工作区上一次用过的、
 * 列表第一个；档位只列这个模型自己的。`compact` 用于侧栏的小图标按钮。
 */
export function NewSessionButton({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const roles = useRoles();
  // 角色库是空的又读取失败时，列表里只有退回的内置角色：告诉用户原因
  const loadError = useRolesStore((state) => (state.roles.length === 0 ? state.error : null));
  const refreshRoles = useRolesStore((state) => state.refresh);
  const createSession = useSessionsStore((state) => state.createSession);
  const loadModelOptions = useSessionsStore((state) => state.loadModelOptions);
  const providers = useSessionsStore(selectModelProviders);
  const optionsLoaded = useSessionsStore((state) => state.modelProviders !== null);
  const optionsError = useSessionsStore((state) => state.modelOptionsError);
  const lastUsed = useSessionsStore((state) =>
    state.workspaceId ? state.lastModelByWorkspace[state.workspaceId] : undefined
  );
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState<string>(ORCHESTRATOR_ROLE_ID);
  // 用户自己选过模型或档位之后就不再跟着角色变
  const [picked, setPicked] = useState<SessionModelRef | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // 「新建会话」快捷键：侧栏的小按钮负责（会话区的大按钮可能同时在），走与点击相同的打开流程
  useActionHandler('new-session', () => trigger.current?.click(), compact);

  const selected = pickRole(roles, roleId);
  const model = picked ?? defaultModelChoice({ providers, roleModel: selected?.model, lastUsed });
  const found = findModel(providers, model);

  const submit = async () => {
    if (!selected) return;
    setCreating(true);
    setError(null);
    const result = await createSession(selected.id, model);
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
        setPicked(null);
        void refreshRoles();
        void loadModelOptions();
      }}
    >
      <DialogTrigger
        ref={trigger}
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
          {loadError && <p className="text-muted-foreground text-xs">读取角色失败：{loadError}</p>}
          <div className="grid gap-1.5 pt-1">
            <label htmlFor={`${id}-model`} className="font-medium text-sm">
              模型
            </label>
            <ModelSelect
              id={`${id}-model`}
              providers={providers}
              value={model}
              onChange={(next) => setPicked(chooseModel(next, model?.thinking))}
            />
            {optionsError ? (
              <p className="text-muted-foreground text-xs">读取模型失败：{optionsError}</p>
            ) : (
              optionsLoaded &&
              providers.length === 0 && (
                <p title={NO_PROVIDERS_HINT} className="text-muted-foreground text-xs">
                  {NO_PROVIDERS}
                </p>
              )
            )}
          </div>
          {found && found.model.thinkingLevels.length > 0 && (
            <div className="grid gap-1.5">
              <span className="flex items-center gap-1.5 font-medium text-sm">
                思考档位
                <ThinkingSourceBadge source={found.model.source} />
              </span>
              <ThinkingLevelPicker
                levels={found.model.thinkingLevels}
                value={model?.thinking}
                onChange={(level) => setPicked(chooseModel(found, level))}
              />
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

/** 一个可选角色：名称（主 agent 带皇冠）、内置徽标、描述（有才显示）。 */
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
        {role.description && (
          <span className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
            {role.description}
          </span>
        )}
      </span>
    </Radio.Root>
  );
}
