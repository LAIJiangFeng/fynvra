import { getSessionsApi } from '@/lib/api/sessions';
import { connectSessionsStore, createSessionsStore } from './createSessionsStore';

export type { SessionsState } from './createSessionsStore';
export type { PendingApproval, SessionRuntime, TimelineMessage, UsageTotals } from './reducer';
export * from './selectors';

// RENDERER_VITE_SESSIONS_MOCK=1 pnpm dev：不接 Main，用内存 mock 演示会话（无需模型 key）
const api = getSessionsApi({ mock: import.meta.env.RENDERER_VITE_SESSIONS_MOCK === '1' });

/** 会话列表、选中、草稿与正文投影；Main 的推送经 reducer 归并。按字段订阅。 */
export const useSessionsStore = createSessionsStore(api);

connectSessionsStore(useSessionsStore, api);
