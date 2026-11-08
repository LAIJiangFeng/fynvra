import type { Workflow } from '@fynvra/core';
import { create } from 'zustand';

/** 只读的工作流列表：编排会话输入框的 `/` 菜单与消息里的标签用。编辑仍在设置页，直接走 IPC */
export interface WorkflowsState {
  workflows: Workflow[];
  loaded: boolean;
  refresh(): Promise<void>;
}

export const useWorkflowsStore = create<WorkflowsState>()((set) => ({
  workflows: [],
  loaded: false,

  async refresh() {
    try {
      const result = await window.fynvra.workflows.list();
      // 读取失败时保留上一次的列表，菜单与标签照常可用
      set(result.ok ? { workflows: result.workflows, loaded: true } : { loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

void useWorkflowsStore.getState().refresh();
