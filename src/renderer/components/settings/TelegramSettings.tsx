import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import type {
  TelegramCandidateView,
  TelegramCardView,
  TelegramStateView,
} from '@shared/types/telegram';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { useWorkspacesStore } from '@/stores/workspaces';
import { InlineMessage, SectionHeader } from './common';

const api = window.fynvra.telegram;

/** 设置 → Telegram：连接、群、待确认需求、最近记录、使用说明。状态全在 Main，这里只读视图、传 id。 */
export function TelegramSettings() {
  const t = useT();
  const id = useId();
  const [state, setState] = useState<TelegramStateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const seq = useRef(0);
  const workspaces = useWorkspacesStore((store) => store.workspaces);
  const workspaceName = (workspaceId: string) =>
    workspaces.find((item) => item.id === workspaceId)?.name ??
    t('settings.telegram.unknownWorkspace');

  // 过期的响应丢弃：只认最后一次 get-state
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const result = await api.getState();
      if (mine !== seq.current) return;
      if (result.ok) setState(result.state);
      else setError(result.error);
    } catch (cause) {
      if (mine === seq.current) setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const off = api.onChanged(() => void load());
    return () => {
      off();
      seq.current += 1;
    };
  }, [load]);

  /** 执行一个操作：失败时显示 Main 返回的错误；成功后再取一次状态 */
  const run = async (action: () => Promise<IpcResult>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.error);
      await load();
      return result.ok;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pending = state?.cards.filter((card) => card.status === 'pending-approval') ?? [];

  return (
    <div className="grid gap-8">
      {error && (
        <InlineMessage tone="error" className="break-all">
          {error}
        </InlineMessage>
      )}

      <section>
        <SectionHeader title={t('settings.telegram.connection')} />
        <div className="grid gap-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={`${id}-enabled`} className="text-sm">
              {t('settings.telegram.enable')}
            </label>
            <Switch
              id={`${id}-enabled`}
              checked={state?.enabled ?? false}
              disabled={!state || busy}
              onCheckedChange={(enabled) => void run(() => api.setEnabled({ enabled }))}
            />
          </div>
          <label htmlFor={`${id}-token`} className="text-sm">
            {t('settings.telegram.token')}
          </label>
          <div className="flex gap-2">
            <Input
              id={`${id}-token`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              placeholder={
                state?.tokenMasked
                  ? t('settings.telegram.tokenSaved', { masked: state.tokenMasked })
                  : t('settings.telegram.tokenPlaceholder')
              }
              onChange={(event) => setToken(event.target.value)}
            />
            <Button
              disabled={!state || busy || token.trim() === ''}
              onClick={async () => {
                if (await run(() => api.setToken({ token: token.trim() }))) setToken('');
              }}
            >
              {t('common.save')}
            </Button>
            {state?.tokenMasked && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => api.setToken({ token: null }))}
              >
                {t('settings.telegram.clearToken')}
              </Button>
            )}
          </div>
          {state && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('settings.telegram.status')}</dt>
              <dd>{t(`settings.telegram.connectionStatus.${state.connection}`)}</dd>
              {state.bot && (
                <>
                  <dt className="text-muted-foreground">{t('settings.telegram.bot')}</dt>
                  <dd className="font-mono">@{state.bot.username}</dd>
                </>
              )}
            </dl>
          )}
          {state?.connection === 'network-error' && (
            <InlineMessage tone="error">{t('settings.telegram.networkHint')}</InlineMessage>
          )}
        </div>
      </section>

      {state && (
        <>
          <section>
            <SectionHeader title={t('settings.telegram.groups')} />
            <div className="grid gap-4">
              <div className="grid gap-2">
                <h4 className="text-muted-foreground text-xs">
                  {t('settings.telegram.candidates')}
                </h4>
                {state.candidates.length === 0 ? (
                  <InlineMessage>{t('settings.telegram.candidatesEmpty')}</InlineMessage>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {state.candidates.map((candidate) => (
                      <CandidateRow
                        key={candidate.chatId}
                        candidate={candidate}
                        busy={busy}
                        onAllow={(workspaceId) =>
                          void run(() => api.allowGroup({ groupId: candidate.chatId, workspaceId }))
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
              <div className="grid gap-2">
                <h4 className="text-muted-foreground text-xs">{t('settings.telegram.allowed')}</h4>
                {state.groups.length === 0 ? (
                  <InlineMessage>{t('settings.telegram.allowedEmpty')}</InlineMessage>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {state.groups.map((group) => (
                      <li key={group.chatId} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-sm">{group.title}</p>
                          <p className="truncate text-muted-foreground text-xs">
                            {workspaceName(group.workspaceId)}
                          </p>
                        </div>
                        <Badge variant={group.active ? 'outline' : 'destructive'}>
                          {t(
                            group.active ? 'settings.telegram.active' : 'settings.telegram.inactive'
                          )}
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={t('common.removeItem', { name: group.title })}
                          onClick={() => void run(() => api.removeGroup({ groupId: group.chatId }))}
                        >
                          {t('settings.telegram.remove')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section>
            <SectionHeader title={t('settings.telegram.pending')} />
            {pending.length === 0 ? (
              <InlineMessage>{t('settings.telegram.pendingEmpty')}</InlineMessage>
            ) : (
              <ul className="divide-y rounded-lg border">
                {pending.map((card) => (
                  <li key={card.id} className="grid gap-2 px-4 py-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{card.title}</p>
                      <p className="text-muted-foreground text-xs">
                        {t('settings.telegram.from', { group: card.groupTitle })}
                      </p>
                    </div>
                    {card.assessment && (
                      <p className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-xs">
                        {card.assessment}
                      </p>
                    )}
                    {card.assessmentIncomplete && (
                      <p className="flex items-center gap-1.5 text-amber-600 text-xs dark:text-amber-400">
                        <TriangleAlert className="size-3.5 shrink-0" />
                        {t('settings.telegram.assessmentIncomplete')}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.resolveCard({ cardId: card.id, action: 'approve' }))
                        }
                      >
                        {t('settings.telegram.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.resolveCard({ cardId: card.id, action: 'reject' }))
                        }
                      >
                        {t('settings.telegram.reject')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHeader title={t('settings.telegram.recent')} />
            {state.cards.length === 0 ? (
              <InlineMessage>{t('settings.telegram.recentEmpty')}</InlineMessage>
            ) : (
              <ul className="divide-y rounded-lg border">
                {state.cards.map((card) => (
                  <CardRow key={card.id} card={card} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section>
        <SectionHeader title={t('settings.telegram.guide')} />
        <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground text-sm">
          {(['token', 'feedback', 'privacy', 'gh', 'proxy', 'offline'] as const).map((step) => (
            <li key={step}>{t(`settings.telegram.guideSteps.${step}`)}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function CandidateRow({
  candidate,
  busy,
  onAllow,
}: {
  candidate: TelegramCandidateView;
  busy: boolean;
  onAllow: (workspaceId: string) => void;
}) {
  const t = useT();
  const workspaces = useWorkspacesStore((store) => store.workspaces);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // 只列 git 工作区；能否允许最终由 Main 校验
  const items = workspaces
    .filter((item) => item.vcs === 'git')
    .map((item) => ({ value: item.id, label: item.name }));
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1 truncate font-medium text-sm">{candidate.title}</span>
      <Select items={items} value={workspaceId} onValueChange={(value) => setWorkspaceId(value)}>
        <SelectTrigger
          className="w-48"
          aria-label={`${t('settings.telegram.workspace')} · ${candidate.title}`}
        >
          <SelectValue placeholder={t('settings.telegram.chooseWorkspace')} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={busy || !workspaceId}
        onClick={() => workspaceId && onAllow(workspaceId)}
      >
        {t('settings.telegram.allow')}
      </Button>
    </li>
  );
}

function CardRow({ card }: { card: TelegramCardView }) {
  const t = useT();
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{t(`settings.telegram.statuses.${card.status}`)}</Badge>
          {card.kind && (
            <Badge variant="secondary">{t(`settings.telegram.kinds.${card.kind}`)}</Badge>
          )}
          <span className="text-muted-foreground text-xs">{card.groupTitle}</span>
        </div>
        <p className="mt-1 truncate text-sm" title={card.title}>
          {card.title}
        </p>
        <p className="text-muted-foreground text-xs">
          {t('settings.telegram.followUps', { count: card.followUps })}
        </p>
      </div>
      {card.prUrl && (
        // 新窗口请求由 Main 的 setWindowOpenHandler 交给系统浏览器
        <a
          href={card.prUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-primary text-xs hover:underline"
        >
          <ExternalLink className="size-3.5" />
          {t('settings.telegram.openPr')}
        </a>
      )}
    </li>
  );
}
