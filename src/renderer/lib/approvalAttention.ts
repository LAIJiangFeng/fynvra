import { useEffect, useState } from 'react';
import type { PendingApproval } from '@/stores/sessions/reducer';

/** Only the live approval push supplies a deadline; event/history placeholders use zero. */
export function isPendingApproval(request: PendingApproval, now: number): boolean {
  return Number.isFinite(request.expiresAt) && request.expiresAt > now;
}

/** Wake at the next deadline, with no timer when there are no actionable requests. */
export function usePendingApprovals(requests: readonly PendingApproval[]): PendingApproval[] {
  const [now, setNow] = useState(Date.now);
  const current = Math.max(now, Date.now());
  const pending = requests.filter((request) => isPendingApproval(request, current));
  const nextExpiry = pending.reduce((next, request) => Math.min(next, request.expiresAt), Infinity);

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, nextExpiry - Math.max(now, Date.now())))
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry, now]);

  return pending;
}
