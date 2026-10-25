import { errorMessage } from '@shared/guards';
import {
  type PickWorktreesRootResult,
  type SessionPreferences,
  sessionPreferencesOf,
  type TimelinePreferences,
  timelinePreferencesOf,
  type WorktreesRootInfo,
  type WorktreesUsage,
} from '@shared/types/settings';
import { create } from 'zustand';
import { createNotificationSettingsStore } from './createNotificationSettingsStore';
import { KEY_PLATFORM } from '@/lib/keybindings/platform';
import { createKeybindingsStore } from '@/lib/keybindings/store';
import { createSettingsStore } from './createSettingsStore';

export type { SettingsState } from './createSettingsStore';

/** 界面偏好（主题、侧面板），经 preload 持久化到 settings.json。 */
export const useSettingsStore = createSettingsStore(window.fynvra.settings);

export interface WorktreesRootState {
  /** Main 推导的根目录与各工作区去向；还没读到时为 null */
  info: WorktreesRootInfo | null;
  /** 正在统计目录大小 */
  measuring: boolean;
  error: string | null;
  /** 重读路径（快）；`measure` 时接着统计各工作区的占用（可能要几秒） */
  refresh(options?: { measure?: boolean }): Promise<void>;
  /** 无参：Main 弹目录选择框；`{ reset: true }`：恢复默认。成功后重读路径 */
  pick(input?: { reset: true }): Promise<PickWorktreesRootResult>;
}

const api = window.fynvra.settings;
// 只认最新一次请求的回包：路径读取与占用统计各自计数，互不顶替
let pathsRequest = 0;
let usageRequest = 0;

async function safely<T>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** 按工作区把占用并到 `info` 上；没有统计结果的工作区保持原样。 */
function withUsage(
  info: WorktreesRootInfo,
  usage: ReadonlyMap<string, WorktreesUsage | undefined>
): WorktreesRootInfo {
  return {
    ...info,
    workspaces: info.workspaces.map((workspace) => {
      const measured = usage.get(workspace.workspaceId);
      return measured === undefined ? workspace : { ...workspace, usage: measured };
    }),
  };
}

function usageOf(info: WorktreesRootInfo | null): Map<string, WorktreesUsage | undefined> {
  return new Map<string, WorktreesUsage | undefined>(
    info?.workspaces.map((workspace) => [workspace.workspaceId, workspace.usage])
  );
}

/** 设置页「通用」：worktree 根目录与占用。数据都由 Main 推导，Renderer 不持有也不回传路径。 */
export const useWorktreesRootStore = create<WorktreesRootState>()((set, get) => {
  async function measure(): Promise<void> {
    const request = ++usageRequest;
    set({ measuring: true });
    const measured = await safely(() => api.worktreesRootInfo());
    // 被更新的统计顶替了（Main 也已取消这一次），等它的结果
    if (request !== usageRequest) return;
    if (!measured.ok) {
      set({ measuring: false, error: measured.error });
      return;
    }
    // 只取占用：统计期间改过目录的话，路径以最近一次读取为准
    set((state) => ({
      measuring: false,
      info: state.info === null ? measured.info : withUsage(state.info, usageOf(measured.info)),
    }));
  }

  return {
    info: null,
    measuring: false,
    error: null,

    async refresh(options) {
      const request = ++pathsRequest;
      const paths = await safely(() => api.worktreesRootInfo({ usage: false }));
      if (request !== pathsRequest) return;
      if (!paths.ok) {
        set({ error: paths.error });
        return;
      }
      // 沿用已统计的占用：重新统计期间不闪成空白
      set((state) => ({ info: withUsage(paths.info, usageOf(state.info)), error: null }));
      if (options?.measure) await measure();
    },

    async pick(input) {
      let result: PickWorktreesRootResult;
      try {
        result = await api.pickWorktreesRoot(input);
      } catch (error) {
        result = { ok: false, code: 'failed', error: errorMessage(error) };
      }
      if (result.ok) await get().refresh();
      return result;
    },
  };
});

// 其他窗口改了偏好：从 Main 重读最新值
window.fynvra.settings.onChanged(() => {
  void useSettingsStore.persist.rehydrate();
  if (useWorktreesRootStore.getState().info !== null) {
    void useWorktreesRootStore.getState().refresh();
  }
});

// --- notifications ---

/** 设置页「通知」：总开关、仅主 agent 完成、提问与审批、声音，与测试通知。 */
export const useNotificationSettingsStore = createNotificationSettingsStore(window.fynvra);

window.fynvra.settings.onChanged(() => {
  if (useNotificationSettingsStore.getState().preferences !== null) {
    void useNotificationSettingsStore.getState().refresh();
  }
// --- keybindings ---
/** 快捷键：覆盖表在 preferences.keybindings，改键立即生效 */
export const useKeybindingsStore = createKeybindingsStore(window.fynvra.settings, KEY_PLATFORM);
void useKeybindingsStore.getState().load();
window.fynvra.settings.onChanged(() => {
  void useKeybindingsStore.getState().load();
});
// --- sessions / timeline ---
type GeneralPatch = Partial<SessionPreferences & TimelinePreferences>;

export interface GeneralPreferencesState {
  /** 生效值：没写过的取默认值；读到 Main 的值之前也是默认值 */
  sessions: SessionPreferences;
  timeline: TimelinePreferences;
  /** 最近一次保存失败的原因 */
  error: string | null;
  load(): Promise<void>;
  /** 先在界面上换上；保存失败时按 Main 重读并记下原因。改了归档天数时让 Main 立即按新设置扫一次 */
  update(patch: GeneralPatch): Promise<void>;
}

function resolveGeneral(preferences: GeneralPatch) {
  return {
    sessions: sessionPreferencesOf(preferences),
    timeline: timelinePreferencesOf(preferences),
  };
}

/**
 * 通用页「会话」「时间线」两组偏好：只读写自己的字段（settings:update 按字段合并），
 * 不经 useSettingsStore 的整块落盘。时间线组件按字段订阅。
 */
export const useGeneralPreferencesStore = create<GeneralPreferencesState>()((set, get) => {
  // 只认最新一次读取；保存开始时作废在途的读取（它读到的是改之前的值）
  let readRequest = 0;
  let writeRequest = 0;
  return {
    ...resolveGeneral({}),
    error: null,

    async load() {
      const request = ++readRequest;
      const result = await safely(() => api.get());
      if (request === readRequest && result.ok) set(resolveGeneral(result.preferences));
    },

    async update(patch) {
      const request = ++writeRequest;
      readRequest += 1;
      set((state) => resolveGeneral({ ...state.sessions, ...state.timeline, ...patch }));
      const result = await safely(() => api.update(patch));
      if (!result.ok) {
        set({ error: `保存失败：${result.error}` });
        await get().load();
        return;
      }
      if (request === writeRequest) set({ ...resolveGeneral(result.preferences), error: null });
      if (patch.archiveIdleDays !== undefined || patch.deleteArchivedDays !== undefined) {
        void window.fynvra.sessions.sweep().catch(() => undefined);
      }
    },
  };
});

void useGeneralPreferencesStore.getState().load();
window.fynvra.settings.onChanged(() => void useGeneralPreferencesStore.getState().load());
