import type { Workflow } from '@fynvra/core';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type {
  WorkflowListResult,
  WorkflowRemoveResult,
  WorkflowSaveResult,
} from '@shared/types/workflows';

export interface WorkflowsApi {
  /** 全部工作流，按保存顺序 */
  list(): Promise<WorkflowListResult>;
  /** 新建或按 id 整份替换；Main 经 parseWorkflow 校验后写 userData/workflows.json */
  save(workflow: Workflow): Promise<WorkflowSaveResult>;
  remove(id: string): Promise<WorkflowRemoveResult>;
}

type Invoker = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };

/** 由 preload/index.ts 注入 ipcRenderer；本文件不 import electron（原因见 domains/providers.ts）。 */
export function createWorkflowsApi(ipc: Invoker): WorkflowsApi {
  return {
    list: () => ipc.invoke(IPC_CHANNELS.WORKFLOWS_LIST),
    save: (workflow) => ipc.invoke(IPC_CHANNELS.WORKFLOWS_SAVE, workflow),
    remove: (id) => ipc.invoke(IPC_CHANNELS.WORKFLOWS_REMOVE, id),
  };
}
