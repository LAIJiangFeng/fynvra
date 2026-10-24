import { errorMessage } from '@shared/guards';
import type { ModelProviderOption } from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import type { ModelProviderView, ProviderImportSource } from '@shared/types/llm';
import { create } from 'zustand';
import { getSessionsApi } from '@/lib/api/sessions';
import type {
  ProviderImportResult,
  ProviderSaveResult,
  ProviderScanImportsResult,
  ProviderTestResult,
  ProviderUpsertInput,
} from '../../preload/domains/providers';

export interface ProvidersState {
  /** 已脱敏：只有 hasApiKey 与末 4 位 */
  providers: ModelProviderView[];
  loaded: boolean;
  /** 最近一次读取失败的原因 */
  error: string | null;
  refresh(): Promise<void>;
  upsert(input: ProviderUpsertInput): Promise<ProviderSaveResult>;
  remove(id: string): Promise<IpcResult>;
  test(id: string): Promise<ProviderTestResult>;
  /** 扫描本机 Claude Code / Codex / CC Switch 的配置（只读，候选已脱敏） */
  scanImports(sources: ProviderImportSource[]): Promise<ProviderScanImportsResult>;
  /** 导入最近一次扫描里的候选，成功后重读列表 */
  importCandidates(candidateIds: string[]): Promise<ProviderImportResult>;
  /**
   * 可用服务（启用、填了 key）里每个模型的思考档位：sessions:model-options 经 worker 按 pi 内置目录算出，
   * 目录外的模型按 reasoning 标记。`providers` 是发请求时的服务列表，判断推理由不由目录决定要用算档位时的标记。
   * 角色编辑器按它列档位，服务弹窗按它判断；null 表示还没读到，读过之后服务列表一变就跟着重读。
   */
  modelOptions: { options: ModelProviderOption[]; providers: ModelProviderView[] } | null;
  /** 最近一次读档位失败的原因；之前读到的 modelOptions 保留 */
  modelOptionsError: string | null;
  loadModelOptions(): Promise<void>;
}

const api = window.fynvra.providers;
const sessionsApi = getSessionsApi();
let modelOptionsRequest = 0;

/** IPC 调用本身失败（极少见）也折成 { ok: false }，组件只处理一种形状。 */
async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export const useProvidersStore = create<ProvidersState>()((set, get) => ({
  providers: [],
  loaded: false,
  error: null,
  modelOptions: null,
  modelOptionsError: null,

  async refresh() {
    const result = await safely(() => api.list());
    set(
      result.ok
        ? { providers: result.providers, loaded: true, error: null }
        : { loaded: true, error: result.error }
    );
    // 读过档位：服务变了（开关推理、停用、加减模型、填 key）跟着重读
    const { modelOptions, modelOptionsError } = get();
    if (result.ok && (modelOptions || modelOptionsError)) void get().loadModelOptions();
  },

  async upsert(input) {
    const result = await safely(() => api.upsert(input));
    if (result.ok) await get().refresh();
    return result;
  },

  async remove(id) {
    const result = await safely(() => api.remove(id));
    if (result.ok) await get().refresh();
    return result;
  },

  test: (id) => safely(() => api.test(id)),

  scanImports: (sources) => safely(() => api.scanImports({ sources })),

  async importCandidates(candidateIds) {
    const result = await safely(() => api.importCandidates({ candidateIds }));
    if (result.ok) await get().refresh();
    return result;
  },

  async loadModelOptions() {
    // 只认最后一次的回答；Main 按协议、模型 id 与 reasoning 标记缓存，重读很便宜
    const request = ++modelOptionsRequest;
    const providers = get().providers;
    const result = await safely(() => sessionsApi.modelOptions());
    if (request !== modelOptionsRequest) return;
    set(
      result.ok
        ? { modelOptions: { options: result.providers, providers }, modelOptionsError: null }
        : { modelOptionsError: result.error }
    );
  },
}));

// 其他窗口或 Main 改了列表：重读
api.onChanged(() => {
  void useProvidersStore.getState().refresh();
});
void useProvidersStore.getState().refresh();
