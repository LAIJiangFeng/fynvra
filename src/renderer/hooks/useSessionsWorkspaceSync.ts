import { useEffect } from 'react';
import { connectSessionsWorkspace } from '@/stores/sessions';

/** 同步订阅工作区切换，避免渲染时捕获的旧 id 在 effect 中覆盖更新的会话选择。 */
export function useSessionsWorkspaceSync(): void {
  useEffect(connectSessionsWorkspace, []);
}
