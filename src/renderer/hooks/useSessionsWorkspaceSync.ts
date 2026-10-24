import { useEffect } from 'react';
import { useSessionsStore } from '@/stores/sessions';
import { useWorkspacesStore } from '@/stores/workspaces';

/** 侧栏选中的工作区同步给会话 store：拉它的会话列表，新建会话也建在这里。 */
export function useSessionsWorkspaceSync(): void {
  const workspaceId = useWorkspacesStore((state) => state.selectedId);
  const setWorkspace = useSessionsStore((state) => state.setWorkspace);

  useEffect(() => {
    setWorkspace(workspaceId);
  }, [workspaceId, setWorkspace]);
}
