import { ShieldAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApprovalCard } from '@/components/chat/ApprovalBar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useT } from '@/i18n/I18nProvider';
import { usePendingApprovals } from '@/lib/approvalAttention';
import { type PendingApproval, selectSessionOf, useSessionsStore } from '@/stores/sessions';
import { useWorkspacesStore } from '@/stores/workspaces';

/** 全工作区的持续提示；只有用户点击才打开详情，不改变当前会话或标签。 */
export function ApprovalAttention() {
  const pending = useSessionsStore((state) => state.pendingApprovals);
  const requests = useMemo(() => Object.values(pending).flat(), [pending]);
  const approvals = usePendingApprovals(requests);
  const count = approvals.length;
  const [open, setOpen] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const t = useT();

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  const groups = new Map<string, PendingApproval[]>();
  for (const request of approvals) {
    const group = groups.get(request.sessionId) ?? [];
    group.push(request);
    groups.set(request.sessionId, group);
  }

  return (
    <Dialog open={open && count > 0} onOpenChange={setOpen}>
      <div
        className={
          count > 0
            ? 'flex shrink-0 flex-wrap items-center gap-3 border-amber-500/50 border-b bg-amber-500/15 px-4 py-3'
            : undefined
        }
      >
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-w-0 flex-1 basis-64"
        >
          {count > 0 && (
            <div className="flex items-start gap-3">
              <ShieldAlert
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400"
              />
              <div className="min-w-0">
                <p className="font-semibold text-sm">{t('approval.attention', { count })}</p>
                <p className="text-muted-foreground text-xs">{t('approval.attentionHint')}</p>
              </div>
            </div>
          )}
        </div>
        {count > 0 && (
          <DialogTrigger render={<Button size="sm" className="shrink-0" />}>
            {t('approval.review')}
          </DialogTrigger>
        )}
      </div>
      {count > 0 && (
        <DialogContent
          initialFocus={title}
          className="flex max-h-[calc(100%-2rem)] flex-col sm:max-w-2xl"
        >
          <DialogHeader className="shrink-0 pr-6">
            <DialogTitle ref={title} tabIndex={-1}>
              {t('approval.attention', { count })}
            </DialogTitle>
            <DialogDescription>{t('approval.attentionHint')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-5 overflow-y-auto">
            {[...groups].map(([sessionId, requests]) => (
              <SessionApprovals key={sessionId} sessionId={sessionId} requests={requests} />
            ))}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function SessionApprovals({
  sessionId,
  requests,
}: {
  sessionId: string;
  requests: PendingApproval[];
}) {
  const session = useSessionsStore(selectSessionOf(sessionId));
  const workspace = useWorkspacesStore((state) =>
    state.workspaces.find((workspace) => workspace.id === session?.workspaceId)
  );
  const heading = useId();
  const t = useT();

  return (
    <section aria-labelledby={heading} className="space-y-2">
      <div>
        <h3 id={heading} className="break-all font-medium text-sm">
          {session
            ? session.title || t('sessions.untitled')
            : t('approval.unknownSession', { id: sessionId })}
        </h3>
        <p className="break-all text-muted-foreground text-xs">
          {workspace?.name ?? t('approval.unknownWorkspace')}
        </p>
      </div>
      {requests.map((request) => (
        <ApprovalCard key={request.id} request={request} />
      ))}
    </section>
  );
}
