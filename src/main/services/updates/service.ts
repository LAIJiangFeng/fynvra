import type { EventEmitter } from 'node:events';
import { asRecord, errorMessage } from '@shared/guards';
import type { UpdateState } from '@shared/types/updates';

const INITIAL_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface UpdaterDriver extends Pick<EventEmitter, 'on' | 'removeListener'> {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceOptions {
  updater: UpdaterDriver;
  currentVersion: string;
  unavailableReason?: 'development' | 'unsupported';
  broadcast(state: UpdateState): void;
  notify(version: string): void;
  requestQuit(): void;
  installFailed?(error: string): void;
}

/** 更新检查和下载串行进行，安装只在退出保护完成后由 Main 调用。 */
export function createUpdateService(options: UpdateServiceOptions) {
  const { updater, broadcast, notify, requestQuit } = options;
  let state: UpdateState = {
    seq: 0,
    currentVersion: options.currentVersion,
    status: options.unavailableReason ? 'disabled' : 'idle',
    ...(options.unavailableReason ? { reason: options.unavailableReason } : {}),
  };
  let started = false;
  let stopped = false;
  let checking = false;
  let installationStarted = false;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  // 手动管理自动下载，统一处理拒绝和重试；安装不得绕过应用退出保护。
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;

  const getState = (): UpdateState => ({ ...state });
  const set = (patch: Partial<UpdateState>) => {
    if (stopped) return;
    state = { ...state, ...patch, seq: state.seq + 1 };
    broadcast(getState());
  };
  const fail = (error: unknown) => {
    if (stopped || state.status === 'downloaded' || state.status === 'disabled') return;
    const installing = state.status === 'installing' && installationStarted;
    const message = errorMessage(error).slice(0, 600);
    set({ status: 'error', error: message });
    // Mac 原生更新器可能在窗口和 agent 关闭后才报告签名或安装失败。
    if (installing) options.installFailed?.(message);
  };
  const available = (raw: unknown) => {
    if (state.status !== 'checking') return;
    const version = asRecord(raw)?.version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      fail(new Error('Invalid stable release version'));
      return;
    }
    set({ status: 'available', version });
  };
  const notAvailable = () => {
    if (state.status === 'checking') set({ status: 'not-available' });
  };
  const progress = (raw: unknown) => {
    if (state.status !== 'downloading') return;
    const percent = asRecord(raw)?.percent;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      set({ percent: Math.max(0, Math.min(100, percent)) });
    }
  };
  const downloaded = () => {
    if (state.status !== 'downloading' || !state.version) return;
    set({ status: 'downloaded', percent: 100 });
    try {
      notify(state.version);
    } catch {
      // 系统通知不可用不影响已下载的更新，界面仍会显示提醒。
    }
  };
  updater.on('update-available', available);
  updater.on('update-not-available', notAvailable);
  updater.on('download-progress', progress);
  updater.on('update-downloaded', downloaded);
  updater.on('error', fail);

  const runCheck = async () => {
    try {
      await updater.checkForUpdates();
      if (!stopped && state.status === 'available') {
        set({ status: 'downloading', percent: 0 });
        await updater.downloadUpdate();
      }
    } catch (error) {
      fail(error);
    } finally {
      checking = false;
    }
  };
  const check = (): UpdateState => {
    if (
      stopped ||
      checking ||
      state.status === 'disabled' ||
      state.status === 'downloaded' ||
      state.status === 'installing'
    )
      return getState();
    checking = true;
    set({
      status: 'checking',
      checkedAt: Date.now(),
      error: undefined,
      version: undefined,
      percent: undefined,
    });
    void runCheck();
    return getState();
  };

  return {
    getState,
    check,
    start() {
      if (started || stopped || options.unavailableReason) return;
      started = true;
      initialTimer = setTimeout(check, INITIAL_DELAY_MS);
      interval = setInterval(check, CHECK_INTERVAL_MS);
      initialTimer.unref?.();
      interval.unref?.();
    },
    requestInstall(): boolean {
      if (stopped || state.status !== 'downloaded') return false;
      set({ status: 'installing' });
      requestQuit();
      return true;
    },
    cancelInstall() {
      if (state.status === 'installing' && !installationStarted) set({ status: 'downloaded' });
    },
    /** 只能在全部窗口同意关闭、agent 收尾完成后调用。 */
    finishInstall(): boolean {
      if (state.status !== 'installing') return false;
      if (installationStarted) return true;
      installationStarted = true;
      try {
        updater.quitAndInstall(false, true);
      } catch (error) {
        fail(error);
      }
      return getState().status === 'installing';
    },
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
      updater.removeListener('update-available', available);
      updater.removeListener('update-not-available', notAvailable);
      updater.removeListener('download-progress', progress);
      updater.removeListener('update-downloaded', downloaded);
      updater.removeListener('error', fail);
    },
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
