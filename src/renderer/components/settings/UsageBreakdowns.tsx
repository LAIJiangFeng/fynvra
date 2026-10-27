import type {
  UsageModel,
  UsageOrchestration,
  UsageRole,
  UsageWorkspace,
} from '@shared/types/usage';
import type { ReactNode } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { formatCompact, formatCost, formatPercent } from './usageFormat';

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card p-5', className)}>
      <h3 className="font-medium text-sm">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-muted-foreground text-sm">{children}</p>;
}

function roleColor(roleId: string | null) {
  if (roleId === 'orchestrator') return 'bg-sky-500';
  if (roleId === 'worker') return 'bg-violet-500';
  return roleId ? 'bg-teal-500' : 'bg-muted-foreground/40';
}

export function UsageRoles({ roles }: { roles: UsageRole[] }) {
  const t = useT();
  const total = roles.reduce((sum, role) => sum + role.totalTokens, 0);
  const name = (id: string | null) =>
    id === null
      ? t('settings.usage.unknown')
      : id === 'orchestrator'
        ? 'Orchestrator'
        : id === 'worker'
          ? 'Worker'
          : id;
  return (
    <Card title={t('settings.usage.byRole')}>
      {roles.length === 0 ? (
        <Empty>{t('settings.usage.emptyRoles')}</Empty>
      ) : (
        <>
          <div className="mt-5 flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            {roles.map((role) => (
              <span
                key={role.roleId ?? ''}
                className={roleColor(role.roleId)}
                style={{ width: `${total ? (role.totalTokens / total) * 100 : 0}%` }}
              />
            ))}
          </div>
          <ul className="mt-4 space-y-4">
            {roles.map((role) => (
              <li key={role.roleId ?? ''}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn('size-2 shrink-0 rounded-full', roleColor(role.roleId))} />
                    <span className="truncate" title={name(role.roleId)}>
                      {name(role.roleId)}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCost(role.cost)}</span>
                </div>
                <p className="mt-1 pl-4 text-muted-foreground text-xs tabular-nums">
                  {formatCompact(role.totalTokens)} Token <span className="px-1">·</span>{' '}
                  {t('settings.usage.sessionCount', { count: role.sessions })}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export function UsageCache({ rate }: { rate: number | null }) {
  const t = useT();
  return (
    <Card title={t('settings.usage.cacheHitRate')}>
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <span className="font-semibold text-2xl tabular-nums">
          {rate === null ? '—' : formatPercent(rate)}
        </span>
        <span className="text-muted-foreground text-xs">{t('settings.usage.cacheRead')}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className="h-full rounded-full bg-violet-500/70"
          style={{ width: `${(rate ?? 0) * 100}%` }}
        />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
        {t(rate === null ? 'settings.usage.emptyCache' : 'settings.usage.cacheHint')}
      </p>
    </Card>
  );
}

export function UsageModels({ models }: { models: UsageModel[] }) {
  const t = useT();
  return (
    <Card title={t('settings.usage.byModel')}>
      {models.length === 0 ? (
        <Empty>{t('settings.usage.emptyModels')}</Empty>
      ) : (
        <ol className="mt-4 max-h-80 space-y-4 overflow-y-auto pr-1">
          {models.map((model, index) => (
            <li key={JSON.stringify([model.provider, model.model])} className="flex gap-3">
              <span className="w-4 shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium" title={model.model ?? undefined}>
                    {model.model ?? t('settings.usage.unknownModel')}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCost(model.cost)}</span>
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-2 text-[11px] text-muted-foreground">
                  <span className="truncate">
                    {model.provider ?? t('settings.usage.unknownProvider')}
                  </span>
                  <span className="tabular-nums">
                    {formatCompact(model.totalTokens)} Token · {formatPercent(model.share)}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-sky-500/60"
                    style={{ width: `${model.share * 100}%` }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function UsageOrchestrationCard({ stats }: { stats: UsageOrchestration }) {
  const t = useT();
  const empty = stats.dispatched === 0 && stats.rejected === 0;
  return (
    <Card title={t('settings.usage.orchestration')}>
      <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
        {t('settings.usage.cohortHint')}
      </p>
      {empty ? (
        <Empty>{t('settings.usage.emptyOrchestration')}</Empty>
      ) : (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 @min-[28rem]:grid-cols-4">
            {(['dispatched', 'completed', 'abandoned', 'failed'] as const).map((key) => (
              <div key={key}>
                <dt className="text-muted-foreground text-xs">{t(`settings.usage.${key}`)}</dt>
                <dd
                  className={cn(
                    'mt-1 font-semibold text-2xl tabular-nums',
                    key === 'completed' && 'text-emerald-600 dark:text-emerald-400',
                    (key === 'abandoned' || key === 'failed') &&
                      'text-amber-600 dark:text-amber-400'
                  )}
                >
                  {formatCompact(stats[key])}
                </dd>
              </div>
            ))}
          </dl>
          <dl className="mt-5 space-y-3 border-t pt-4 text-xs">
            {stats.firstPassRate !== undefined && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('settings.usage.firstPassRate')}</dt>
                <dd className="tabular-nums">{formatPercent(stats.firstPassRate)}</dd>
              </div>
            )}
            {stats.averageAttempts !== undefined && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('settings.usage.averageAttempts')}</dt>
                <dd className="tabular-nums">{stats.averageAttempts.toFixed(1)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground" title={t('settings.usage.rejectedHint')}>
                {t('settings.usage.rejected')}
              </dt>
              <dd className="tabular-nums">{formatCompact(stats.rejected)}</dd>
            </div>
            {stats.workerCostPerMergedTask !== undefined && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground" title={t('settings.usage.workerCostHint')}>
                  {t('settings.usage.workerCost')}
                </dt>
                <dd className="tabular-nums">{formatCost(stats.workerCostPerMergedTask)}</dd>
              </div>
            )}
          </dl>
        </>
      )}
    </Card>
  );
}

export function UsageWorkspaces({ workspaces }: { workspaces: UsageWorkspace[] }) {
  const t = useT();
  const maximum = Math.max(1, ...workspaces.map((workspace) => workspace.totalTokens));
  return (
    <Card title={t('settings.usage.byWorkspace')} className="@min-[48rem]:col-span-2">
      {workspaces.length === 0 ? (
        <Empty>{t('settings.usage.emptyWorkspaces')}</Empty>
      ) : (
        <ul className="mt-4 grid gap-x-8 gap-y-4 @min-[48rem]:grid-cols-2">
          {workspaces.map((workspace) => (
            <li key={workspace.workspaceId ?? ''} className="min-w-0">
              <div className="flex justify-between gap-3 text-xs">
                <span className="truncate font-medium" title={workspace.name ?? undefined}>
                  {workspace.name ?? t('settings.usage.unknown')}
                </span>
                <span className="shrink-0 tabular-nums">{formatCost(workspace.cost)}</span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div
                  className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-full bg-muted-foreground/50"
                    style={{ width: `${(workspace.totalTokens / maximum) * 100}%` }}
                  />
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {formatCompact(workspace.totalTokens)} Token
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
