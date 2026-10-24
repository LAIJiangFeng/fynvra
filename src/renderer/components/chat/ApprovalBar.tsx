import type { ApprovalKind } from '@shared/types/chat';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { selectApprovalsOf, useSessionsStore } from '@/stores/sessions';

const KIND_LABEL: Record<ApprovalKind, string> = {
  command: '执行命令',
  'file-edit': '编辑文件',
  'file-write': '写入文件',
  mcp: 'MCP 工具',
};

/** 审批条：有待审批请求时固定在输入框上方，先到先审。 */
export function ApprovalBar({ sessionId }: { sessionId: string }) {
  const approvals = useSessionsStore(selectApprovalsOf(sessionId));
  const respond = useSessionsStore((state) => state.respondApproval);
  const request = approvals[0];
  if (!request) return null;

  return (
    <section aria-label="待审批" className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4">
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Badge variant="outline" className="border-amber-500/40">
                {KIND_LABEL[request.kind]}
              </Badge>
              <span className="truncate font-medium">{request.title}</span>
              {approvals.length > 1 && (
                <span className="shrink-0 text-muted-foreground text-xs">
                  还有 {approvals.length - 1} 条
                </span>
              )}
            </div>
            {request.detail && (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background/70 px-2 py-1.5 font-mono text-xs">
                {request.detail}
              </pre>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => void respond(request.id, 'deny')}>
            拒绝
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void respond(request.id, 'allowSession')}
          >
            本会话都允许
          </Button>
          <Button size="sm" onClick={() => void respond(request.id, 'allow')}>
            允许
          </Button>
        </div>
      </div>
    </section>
  );
}
