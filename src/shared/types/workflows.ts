import type { Workflow } from '@fynvra/core';
import type { IpcResult } from './ipc';

/** `workflows:list`：按保存顺序的全部工作流。 */
export type WorkflowListResult = IpcResult<{ workflows: Workflow[] }>;
/** `workflows:save`：Main 经 parseWorkflow 收窄、归一化后保存的工作流。 */
export type WorkflowSaveResult = IpcResult<{ workflow: Workflow }>;
/** `workflows:remove` */
export type WorkflowRemoveResult = IpcResult;
