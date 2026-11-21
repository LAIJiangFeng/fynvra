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

/** 渠道会话的档位：只读分诊 triage，或受限值班 restricted */
export type ChannelProfile = 'triage' | 'restricted';

/** 会话状态；已归档为 archived，会话已被用户删掉为 missing */
export type ChannelSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting-approval'
  | 'error'
  | 'archived'
  | 'missing';

/** channel.snapshot() 的结果：只有协调者会话属于本插件的 run 与其下的 task */
export interface ChannelSnapshot {
  runs: { id: string; coordinatorSessionId: string }[];
  tasks: {
    id: string;
    runId: string;
    title: string;
    status: 'todo' | 'in-progress' | 'in-review' | 'completed' | 'failed' | 'abandoned';
    pullRequest?: { url: string };
  }[];
}

/** channel.filterOutbound() 的结果：本机信息已替换；命中密钥时整条拒绝 */
export type ChannelFilterResult = { ok: true; text: string } | { ok: false; reason: 'secret' };

/**
 * channel.prompt 的一个附件：插件先把文件写到 `${api.dataDir}/attachments/<file>`。
 * file 只允许 `[A-Za-z0-9._-]`、≤ 128 字符、不含 `..`；name 是显示用的原始文件名（≤ 200 字符，核心去掉路径与控制字符，取它的扩展名判断文档格式）
 */
export interface ChannelAttachment {
  file: string;
  name: string;
}

/** 被拒的附件：不支持的格式 / 没有文字 / 读不了（含不存在、符号链接、目录）/ 超过输入框的上限 */
export interface ChannelAttachmentRejection {
  name: string;
  reason: 'unsupported' | 'empty' | 'unreadable' | 'size';
}

/** channel.prompt() 的结果 */
export interface ChannelPromptResult {
  delivered: boolean;
  rejected: ChannelAttachmentRejection[];
}

/** 事件 `channel.session`：本插件会话的状态变化 */
export interface ChannelSessionEvent {
  sessionId: string;
  status: ChannelSessionStatus;
}

/** 事件 `channel.orchestrationChanged`：该工作区有本插件的 run 时才发 */
export interface ChannelOrchestrationEvent {
  workspaceId: string;
}

/** 宿主调插件 `channel.report` 的入参：本插件 triage 会话里的 triage_report 等调用（input 未收窄） */
export interface ChannelReportCall {
  sessionId: string;
  method: string;
  input: unknown;
}

/** `channel.report` 处理函数的返回值（同 host-invoke 的 HostCallResult） */
export type ChannelReportResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string };

export interface FynvraPluginApi {
  /** 本插件 id（市场 id） */
  readonly pluginId: string;
  /** 本插件私有数据目录的绝对路径；channel.prompt 的附件写在其下的 `attachments/`（插件自建、自己清理） */
  readonly dataDir: string;
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
  /** 渠道 API（全部需要 channel 权限，只能作用于本插件拥有的会话 / 工作区 / 任务） */
  channel: {
    /** 在工作区的干净检出里建档位会话（须是有默认分支与远端的 git 工作区），归属本插件 */
    createSession(input: {
      workspaceId: string;
      profile: ChannelProfile;
      title: string;
    }): Promise<{ sessionId: string }>;
    /** 把干净检出切到 origin 默认分支最新提交（本插件该工作区有会话在跑时拒绝） */
    refreshCheckout(input: { workspaceId: string }): Promise<void>;
    originCommit(input: { workspaceId: string }): Promise<{ commit: string }>;
    /**
     * 会话空闲则投递，忙或已归档时不发（delivered: false）；text ≤ 64 KB，没有附件时须非空。
     * attachments 最多 20 个，格式与上限同聊天输入框：图片原样发给模型，文档抽成文字包在
     * `<untrusted-content source="attachment">` 里接在 text 之后；不合格的列在 rejected。核心不删附件文件。
     */
    prompt(input: {
      sessionId: string;
      text: string;
      attachments?: ChannelAttachment[];
    }): Promise<ChannelPromptResult>;
    sessionStatus(input: { sessionId: string }): Promise<{ status: ChannelSessionStatus }>;
    snapshot(input: { workspaceId: string }): Promise<ChannelSnapshot>;
    filterOutbound(input: { text: string }): Promise<ChannelFilterResult>;
    /** 只对本插件 run 下的任务；先过滤再存，命中密钥时拒绝；null 清除 */
    setPullRequestNote(input: { taskId: string; text: string | null }): Promise<void>;
  };
  ui: {
    /**
     * 声明式设置页（需要 ui 权限）：整份替换本插件的设置页，Main 校验不通过时 reject。
     * 形状见 UI 描述 v1（`src/shared/types/appPluginUi.ts` 的 PluginUi）。用户操作经
     * `handle('ui.action', ({ action, itemKey?, values }) => ...)` 送达，返回 `{ ok: false, error }` 表示失败
     */
    render(schema: unknown): Promise<void>;
  };
  /** 旧数据迁移：只对官方 Telegram 插件（com.fynvra.telegram）开放，其他插件调用会被拒绝（method not allowed） */
  legacy: {
    /** 旧内置版 telegram.json 的原始对象（含明文 token，字段由插件自行收窄）；文件不存在时为 null */
    telegramData(): Promise<unknown | null>;
    /** 把文件改名为 telegram.json.migrated-<epoch ms> 留底；幂等 */
    telegramMigrated(): Promise<void>;
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
