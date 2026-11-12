import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdateService } from './service';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => {
    this.emit('update-available', { version: '0.1.1' });
  });
  downloadUpdate = vi.fn(async () => {
    this.emit('download-progress', { percent: 53.2 });
    this.emit('update-downloaded', { version: '0.1.1' });
  });
  quitAndInstall = vi.fn();
}

function setup(unavailableReason?: 'development' | 'unsupported' | 'manual-install') {
  const updater = new FakeUpdater();
  const broadcast = vi.fn();
  const notify = vi.fn();
  const requestQuit = vi.fn();
  const installFailed = vi.fn();
  const service = createUpdateService({
    updater,
    currentVersion: '0.1.0',
    unavailableReason,
    broadcast,
    notify,
    requestQuit,
    installFailed,
  });
  return { updater, service, broadcast, notify, requestQuit, installFailed };
}

describe('应用更新服务', () => {
  it('Mac 原生安装异步失败时回报一次，关闭窗口后仍能提示并结束应用', async () => {
    const { service, updater, installFailed } = setup();
    service.check();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloaded'));
    service.requestInstall();
    expect(service.finishInstall()).toBe(true);
    expect(installFailed).not.toHaveBeenCalled();
    updater.emit('error', new Error('Squirrel 签名校验失败'));
    expect(service.getState()).toMatchObject({ status: 'error', error: 'Squirrel 签名校验失败' });
    expect(installFailed).toHaveBeenCalledExactlyOnceWith('Squirrel 签名校验失败');
    updater.emit('error', new Error('重复安装错误'));
    expect(installFailed).toHaveBeenCalledOnce();
    service.stop();
  });
  afterEach(() => vi.useRealTimers());

  it('自动检查并下载，完成后提醒，但不自行重启或安装', async () => {
    vi.useFakeTimers();
    const { updater, service, broadcast, notify, requestQuit } = setup();
    service.start();
    service.start();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({ status: 'downloaded', version: '0.1.1' });
    expect(broadcast.mock.calls.map(([state]) => state.status)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'downloaded',
    ]);
    expect(notify).toHaveBeenCalledWith('0.1.1');
    expect(requestQuit).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    service.check();
    updater.emit('update-not-available');
    updater.emit('error', new Error('过期检查错误'));
    expect(service.getState().status).toBe('downloaded');
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    service.stop();
  });

  it('开发环境和未支持的平台不请求网络，停止服务清理定时器', async () => {
    vi.useFakeTimers();
    for (const reason of ['development', 'unsupported', 'manual-install'] as const) {
      const { service, updater } = setup(reason);
      service.start();
      service.check();
      expect(service.getState()).toMatchObject({ status: 'disabled', reason });
      expect(service.requestInstall()).toBe(false);
      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      service.stop();
    }
    const { service, updater } = setup();
    service.start();
    service.stop();
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('检查失败可重试，重复检查不并发，下载错误不伪报成功', async () => {
    const { service, updater, notify } = setup();
    let reject!: (error: Error) => void;
    updater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    expect(service.check().status).toBe('checking');
    service.check();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    reject(new Error('网络不可用'));
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ status: 'error', error: '网络不可用' })
    );
    updater.downloadUpdate.mockRejectedValueOnce(new Error('下载失败'));
    service.check();
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ status: 'error', error: '下载失败' })
    );
    expect(notify).not.toHaveBeenCalled();
    service.check();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloaded'));
    service.stop();
  });

  it('没有更新时保持当前版本，四小时后再次自动检查', async () => {
    vi.useFakeTimers();
    const { service, updater } = setup();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available');
    });
    service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.getState()).toMatchObject({ status: 'not-available', currentVersion: '0.1.0' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('只有下载完成才能请求安装，确认退出和收尾前不启动安装器，取消后可再试', async () => {
    const { service, updater, requestQuit } = setup();
    expect(service.requestInstall()).toBe(false);
    expect(service.finishInstall()).toBe(false);
    service.check();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloaded'));
    expect(service.requestInstall()).toBe(true);
    expect(service.getState().status).toBe('installing');
    expect(requestQuit).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    service.cancelInstall();
    expect(service.getState().status).toBe('downloaded');
    expect(service.finishInstall()).toBe(false);
    service.requestInstall();
    expect(service.finishInstall()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    service.finishInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    service.stop();
  });

  it('安装器启动失败返回失败，不让无窗口进程永久挂起', async () => {
    const { service, updater } = setup();
    service.check();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloaded'));
    service.requestInstall();
    updater.quitAndInstall.mockImplementation(() => {
      updater.emit('error', new Error('安装失败'));
    });
    expect(service.finishInstall()).toBe(false);
    expect(service.getState()).toMatchObject({ status: 'error', error: '安装失败' });
    service.stop();
  });

  it('快照是副本，序号递增，异常进度不进入界面', async () => {
    const { service, updater, broadcast } = setup();
    updater.downloadUpdate.mockImplementation(async () => undefined);
    service.check();
    await vi.waitFor(() => expect(service.getState().status).toBe('downloading'));
    updater.emit('download-progress', { percent: 200 });
    expect(service.getState().percent).toBe(100);
    updater.emit('download-progress', { percent: Number.NaN });
    expect(service.getState().percent).toBe(100);
    const state = service.getState();
    state.status = 'error';
    expect(service.getState().status).toBe('downloading');
    const seqs = broadcast.mock.calls.map(([snapshot]) => snapshot.seq);
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])).toBe(true);
    service.stop();
  });
});
