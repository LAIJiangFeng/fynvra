// Fynvra 插件作者用的宿主 API 类型（ARCHITECTURE §7.12「Fynvra 插件」）。
// 插件入口（清单的 host.main，ESM）导出 activate(api)，可选 deactivate()；api 的每个方法经 RPC 交给 Main 处理，
// Main 按清单权限检查。本文件只有类型，插件仓库可整份照抄。

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** workspaces.list() 的一项；不含路径 */
export interface PluginWorkspace {
  id: string;
  name: string;
  /** 是否 git 工作区 */
  git: boolean;
}

/** net.proxyEnv() 的结果：只有这三个键，没有代理时缺省 */
export interface PluginProxyEnv {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
}

export type Unsubscribe = () => void;

export interface FynvraPluginApi {
  /** 本插件 id（市场 id） */
  readonly pluginId: string;
  /** 写进 Fynvra 日志（前缀 `[plugin:<id>]`，每秒最多 100 行，输出前抹掉本插件的密钥）；不等待结果 */
  log(level: PluginLogLevel, message: string): void;
  /** 私有 JSON 存储（≤ 5 MB，原子写）；没写过时 read 返回 null */
  storage: {
    read<T = unknown>(): Promise<T | null>;
    write(value: unknown): Promise<void>;
  };
  /** 按插件隔离的密钥；key `[A-Za-z0-9_.-]{1,64}`，value ≤ 4 KB，null 删除 */
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string | null): Promise<void>;
  };
  /** 桌面通知（需要 notifications 权限；遵守通知总开关与提示音） */
  notify(input: { title: string; body: string }): Promise<void>;
  net: {
    /** 当前的代理环境变量（需要 network 权限）；插件进程本身不带代理变量 */
    proxyEnv(): Promise<PluginProxyEnv>;
  };
  workspaces: {
    /** 已挂入的工作区（需要 workspaces 权限），不含路径 */
    list(): Promise<PluginWorkspace[]>;
  };
  ui: {
    /**
     * 声明式设置页（需要 ui 权限）：整份替换本插件的设置页，Main 校验不通过时 reject。
     * 形状见 UI 描述 v1（`src/shared/types/appPluginUi.ts` 的 PluginUi）。用户操作经
     * `handle('ui.action', ({ action, itemKey?, values }) => ...)` 送达，返回 `{ ok: false, error }` 表示失败
     */
    render(schema: unknown): Promise<void>;
  };
  /** 订阅宿主事件（如 H3 的 channel.session）；返回取消订阅 */
  on(event: string, handler: (payload: unknown) => void): Unsubscribe;
  /** 处理宿主发来的调用（如 H2 的 ui.action）；同名再注册覆盖；处理函数抛错时只把 message 传回 */
  handle(name: string, handler: (args: unknown) => unknown): Unsubscribe;
}

/** 插件入口模块的形状 */
export interface FynvraPluginModule {
  activate(api: FynvraPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
