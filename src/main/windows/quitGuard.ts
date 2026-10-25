/** 先完成窗口的未保存确认，再关闭服务；取消退出不改变服务生命周期。 */
export function createQuitGuard({
  windows,
  shutdown,
  quit,
  completeQuit = quit,
  mac,
}: {
  windows(): { close(): void }[];
  shutdown(): Promise<void>;
  quit(): void;
  /** 服务收尾完成后的最终动作；更新安装只能放在这里。 */
  completeQuit?(): void;
  mac: boolean;
}) {
  let requested = false;
  let stopping = false;
  let stopped = false;
  return {
    beforeQuit(event: { preventDefault(): void }) {
      if (stopped) return;
      event.preventDefault();
      requested = true;
      const opened = windows();
      if (opened.length > 0) {
        for (const window of opened) window.close();
        return;
      }
      if (stopping) return;
      stopping = true;
      void shutdown().finally(() => {
        stopped = true;
        completeQuit();
      });
    },
    allWindowsClosed() {
      if (!mac || requested) quit();
    },
    cancel() {
      requested = false;
    },
  };
}
