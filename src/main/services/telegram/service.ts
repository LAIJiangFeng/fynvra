// Telegram 群反馈值班的 Main 服务（ARCHITECTURE §7.14）：轮询、群发现与准入、分诊投递、triage_report 路由、
// 追问、值班投递、卡片与任务关联、PR 结果通知。群里只会收到过滤后的 triage 回复与固定模板。
import { errorMessage } from '@shared/guards';
import type { HostCallResult } from '@shared/types/agent';
import type { IpcResult } from '@shared/types/ipc';
import type { OrchestrationSnapshotView } from '@shared/types/orchestration';
import {
  maskTelegramToken,
  type TelegramCardAction,
  type TelegramCardStatus,
  type TelegramConnection,
  type TelegramStateView,
} from '@shared/types/telegram';
import type { Workspace } from '@shared/types/workspace';
import type { AgentHostService } from '../agentHost/agentHost';
import {
  type LocalInfoContext,
  registerSecretSource,
  sanitizeLocalInfo,
  scanSecrets,
} from '../secrets';
import {
  redactToken,
  TELEGRAM_TOKEN_PATTERN,
  type TelegramApi,
  TelegramApiError,
  type TgChat,
  type TgMessage,
  type TgUpdate,
} from './api';
import type { CleanCheckout } from './cleanCheckout';
import {
  dutyPrompt,
  MAX_FOLLOW_UPS,
  parseAssessment,
  parseBugCommand,
  parseTriageInput,
  pullRequestSection,
  TEMPLATES,
  triagePrompt,
} from './content';
import {
  emptyTelegramData,
  MAX_CANDIDATES,
  MAX_CARDS,
  type StoredCard,
  type StoredGroup,
  type TelegramData,
  type TelegramStore,
} from './store';

export const DEBOUNCE_MS = 3_000;
export const RATE_LIMIT_PER_HOUR = 5;
export const MAX_QUEUE_PER_GROUP = 50;
export const FOLLOW_UP_TIMEOUT_MS = 24 * 60 * 60_000;
export const DUTY_IDLE_MS = 30 * 60_000;
export const MAINTENANCE_INTERVAL_MS = 10 * 60_000;
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const ITEM_TEXT_MAX = 4_000;

/** 还在分诊阶段、回复它就是对这张卡片的追问回复的状态；其余状态的卡片被回复时按新反馈处理 */
const RETRIAGE_STATUSES: ReadonlySet<TelegramCardStatus> = new Set([
  'asking',
  'answered',
  'invalid',
  'declined',
  'unconfirmed',
  'unreported',
]);
const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'in-progress', 'in-review']);

export interface TelegramServiceDeps {
  store: TelegramStore;
  api: TelegramApi;
  agentHost: Pick<AgentHostService, 'createProfileSession' | 'promptWhenIdle' | 'observe' | 'get'>;
  workspaces: { get(id: string): Workspace | undefined };
  /** 工作区的编排快照（读 runs 与 tasks） */
  snapshot(
    workspaceId: string
  ): Promise<Pick<OrchestrationSnapshotView, 'runs' | 'tasks'> | undefined>;
  cleanCheckout: CleanCheckout;
  /** 已知密钥（生产为 collectAppSecrets，含登记的 telegram token） */
  knownSecrets(): Promise<readonly string[]>;
  /** 本机路径、用户名、主机名 */
  localInfo(): Promise<LocalInfoContext>;
  /** 桌面通知（实现方遵守通知总开关） */
  notify(title: string, body: string): void;
  now?(): number;
  log?(message: string): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  debounceMs?: number;
}

export interface TelegramService {
  /** 读盘、登记 token 为已知密钥、订阅会话事件，启用且有 token 时开始轮询 */
  start(): Promise<void>;
  /** 停止轮询与定时器，等待落盘 */
  stop(): Promise<void>;
  getState(): TelegramStateView;
  setToken(token: string | null): Promise<IpcResult>;
  allowGroup(chatId: number, workspaceId: string): Promise<IpcResult>;
  removeGroup(chatId: number): Promise<IpcResult>;
  resolveCard(cardId: number, action: TelegramCardAction): Promise<IpcResult>;
  setEnabled(enabled: boolean): Promise<IpcResult>;
  onChange(listener: () => void): () => void;
  /** agentHost 的 deps.telegram.invoke（只有 triage 会话的调用会到这里） */
  invoke(
    sessionId: string,
    method: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<HostCallResult>;
  /** 编排状态变化（notifyChanged 分发过来） */
  orchestrationChanged(workspaceId: string): void;
  /** setPullRequestBodyExtension 的实现：属于卡片的任务追加「问题 / 来源」 */
  pullRequestBodyExtension(taskId: string): string | undefined;
  /** 定时维护（追问超时、PR 结果、值班空闲）；定时器每 10 分钟调用一次，测试可直接调用 */
  maintain(): Promise<void>;
}

interface QueuedItem {
  chatId: number;
  /** 追问回复：对应的卡片 */
  cardId?: number;
  /** 按新反馈处理但回复了旧卡片：作背景 */
  contextCardId?: number;
  fromId: number;
  sender: string;
  messageIds: number[];
  /** 群回复回复这条消息（条目的第一条） */
  replyTo: number;
  texts: string[];
  /** 最后一条消息的时间（消息自带的发送时间，ms） */
  lastDate: number;
  readyAt: number;
}

interface InflightItem extends QueuedItem {
  reported: boolean;
}

interface DutyRound {
  cardId: number;
  sessionId: string;
  knownTaskIds: Set<string>;
}

function displayName(user: { first_name?: string; last_name?: string; username?: string }): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (name || user.username || '匿名').slice(0, 128);
}

function isGroupChat(chat: TgChat | undefined): chat is TgChat {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

export function createTelegramService(deps: TelegramServiceDeps): TelegramService {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[telegram] ${message}`));
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const wait =
    deps.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      }));

  let data: TelegramData = emptyTelegramData();
  let connection: TelegramConnection = 'disabled';
  let poll: { controller: AbortController; done: Promise<void> } | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let unobserve: (() => void) | undefined;
  let unregisterSecret: (() => void) | undefined;
  let lastWrite: Promise<void> = Promise.resolve();
  /** PR 正文附加段同步调用，用最近一次取到的已知密钥 */
  let cachedKnown: readonly string[] = [];
  const listeners = new Set<() => void>();
  const queues = new Map<number, QueuedItem[]>();
  const chatTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const pumping = new Set<number>();
  const inflight = new Map<string, InflightItem>();
  const rate = new Map<number, number[]>();
  const dutyRounds = new Map<string, DutyRound>();
  const dutyBusy = new Set<string>();
  const dutySettledAt = new Map<string, number>();
  const prChecks = new Map<string, ReturnType<typeof setTimeout>>();

  const safe = (text: string) => redactToken(text, data.token);
  const warn = (message: string) => log(safe(message));

  // ---------- 状态与落盘 ----------

  const persist = (): Promise<void> => {
    const write = deps.store.save(data);
    lastWrite = write.catch((error) => warn(`保存 telegram.json 失败：${errorMessage(error)}`));
    return write;
  };

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        warn(`变更监听失败：${errorMessage(error)}`);
      }
    }
  };

  /** 改了数据：落盘（失败只记日志）并通知 */
  const commit = () => {
    void persist().catch(() => undefined);
    emit();
  };

  const setConnection = (next: TelegramConnection) => {
    if (connection === next) return;
    connection = next;
    emit();
  };

  const idleConnection = (): TelegramConnection =>
    !data.enabled ? 'disabled' : data.token ? 'connecting' : 'no-token';

  // ---------- 查找 ----------

  const cardById = (id: number) => data.cards.find((card) => card.id === id);
  const groupOf = (chatId: number) => data.groups.find((group) => group.chatId === chatId);
  const groupOfSession = (sessionId: string) =>
    data.groups.find((group) => group.triageSessionId === sessionId);
  const workspaceOfDuty = (sessionId: string): string | undefined =>
    Object.entries(data.workspaces).find(([, entry]) => entry.dutySessionId === sessionId)?.[0];

  const sessionAlive = (sessionId: string | undefined): boolean => {
    if (!sessionId) return false;
    const session = deps.agentHost.get(sessionId);
    return session !== undefined && session.archivedAt === undefined;
  };

  /** 本工作区的档位会话（分诊与值班）是否有正在跑的 */
  const profileSessionRunning = (workspaceId: string): boolean => {
    const ids = [
      ...data.groups.filter((g) => g.workspaceId === workspaceId).map((g) => g.triageSessionId),
      data.workspaces[workspaceId]?.dutySessionId,
    ];
    return ids.some((id) => {
      const status = id ? deps.agentHost.get(id)?.status : undefined;
      return status === 'running' || status === 'waiting-approval';
    });
  };

  const refreshCheckout = async (workspace: Workspace) => {
    if (profileSessionRunning(workspace.id)) return;
    const refreshed = await deps.cleanCheckout.refresh(workspace);
    if (!refreshed.ok) warn(`刷新干净检出失败（${workspace.id}）：${refreshed.error}`);
  };

  // ---------- 群消息发送（只接受过滤后的 triage 回复与固定模板） ----------

  const sendToGroup = async (card: StoredCard, text: string, replyTo: number) => {
    const group = groupOf(card.chatId);
    const token = data.token;
    if (!token || !group?.active || text.trim() === '') return;
    try {
      const sent = await deps.api.sendMessage(token, { chatId: card.chatId, text, replyTo });
      card.botMessageIds = [...card.botMessageIds, sent.messageId].slice(-20);
    } catch (error) {
      warn(`发送群消息失败（卡片 #${card.id}）：${errorMessage(error)}`);
    }
  };

  const sendTriageReply = async (
    card: StoredCard,
    reply: string,
    replyTo: number,
    ctx: LocalInfoContext,
    known: readonly string[]
  ) => {
    const sanitized = sanitizeLocalInfo(reply, ctx);
    const scan = scanSecrets(sanitized, known);
    if (scan.hit) {
      card.lastReply = TEMPLATES.blocked;
      deps.notify(
        'Telegram 群回复已拦下',
        `卡片 #${card.id} 的回复疑似含密钥（${scan.kinds.join(', ')}），已改发中性提示。`
      );
      await sendToGroup(card, TEMPLATES.blocked, replyTo);
      return;
    }
    card.lastReply = sanitized;
    await sendToGroup(card, sanitized, replyTo);
  };

  // ---------- 会话 ----------

  const createTriageSession = async (
    workspace: Workspace,
    title: string
  ): Promise<IpcResult<{ sessionId: string; path: string }>> => {
    const ensured = await deps.cleanCheckout.ensure(workspace);
    if (!ensured.ok) return ensured;
    const created = await deps.agentHost.createProfileSession({
      workspaceId: workspace.id,
      profile: 'triage',
      cwd: ensured.path,
      title: `Telegram 分诊 · ${title}`,
    });
    if (!created.ok) return created;
    return { ok: true, sessionId: created.session.id, path: ensured.path };
  };

  const ensureTriageSession = async (group: StoredGroup, workspace: Workspace) => {
    if (sessionAlive(group.triageSessionId)) return true;
    const created = await createTriageSession(workspace, group.title);
    if (!created.ok) {
      warn(`重建分诊会话失败：${created.error}`);
      return false;
    }
    group.triageSessionId = created.sessionId;
    commit();
    return true;
  };

  const ensureDutySession = async (workspace: Workspace): Promise<string | undefined> => {
    const entry = data.workspaces[workspace.id];
    if (entry && sessionAlive(entry.dutySessionId)) return entry.dutySessionId;
    const ensured = await deps.cleanCheckout.ensure(workspace);
    if (!ensured.ok) {
      warn(`准备干净检出失败（${workspace.id}）：${ensured.error}`);
      return undefined;
    }
    const created = await deps.agentHost.createProfileSession({
      workspaceId: workspace.id,
      profile: 'restricted',
      cwd: ensured.path,
      title: 'Telegram 值班',
    });
    if (!created.ok) {
      warn(`创建值班会话失败（${workspace.id}）：${created.error}`);
      return undefined;
    }
    data.workspaces[workspace.id] = {
      cleanCheckoutPath: ensured.path,
      dutySessionId: created.session.id,
    };
    commit();
    return created.session.id;
  };

  // ---------- 分诊投递 ----------

  const scheduleChat = (chatId: number, delay: number) => {
    clearTimeout(chatTimers.get(chatId));
    chatTimers.set(
      chatId,
      setTimeout(() => {
        chatTimers.delete(chatId);
        void pumpChat(chatId);
      }, delay)
    );
  };

  const pumpChat = async (chatId: number): Promise<void> => {
    if (pumping.has(chatId)) return;
    const queue = queues.get(chatId);
    const head = queue?.[0];
    if (!queue || !head) return;
    const group = groupOf(chatId);
    if (!group?.active) {
      queues.delete(chatId);
      return;
    }
    if (inflight.has(group.triageSessionId)) return;
    if (head.readyAt > now()) {
      scheduleChat(chatId, head.readyAt - now());
      return;
    }
    const workspace = deps.workspaces.get(group.workspaceId);
    if (!workspace) {
      warn(`群绑定的工作区不存在：${group.workspaceId}`);
      return;
    }
    pumping.add(chatId);
    try {
      if (!(await ensureTriageSession(group, workspace))) return;
      const sessionId = group.triageSessionId;
      if (deps.agentHost.get(sessionId)?.status !== 'idle') return; // 忙：settled / idle 事件后再投
      await refreshCheckout(workspace);
      const item = queue[0];
      if (!item || inflight.has(sessionId)) return;
      const card = item.cardId === undefined ? undefined : cardById(item.cardId);
      const context = item.contextCardId === undefined ? undefined : cardById(item.contextCardId);
      const prompt = triagePrompt({
        groupTitle: group.title,
        ...(card
          ? {
              card: {
                id: card.id,
                followUps: card.followUps,
                content: card.content,
                ...(card.lastReply ? { lastReply: card.lastReply } : {}),
              },
            }
          : {}),
        ...(context
          ? {
              context: {
                id: context.id,
                content: context.content,
                ...(context.lastReply ? { lastReply: context.lastReply } : {}),
              },
            }
          : {}),
        sender: item.sender,
        messageIds: item.messageIds,
        text: item.texts.join('\n'),
      });
      // 先登记在途条目：triage_report 可能在 promptWhenIdle 返回前就到
      inflight.set(sessionId, { ...item, reported: false });
      const sent = await deps.agentHost.promptWhenIdle(sessionId, prompt);
      if (sent.ok && sent.delivered) {
        queue.shift();
        if (queue.length === 0) queues.delete(chatId);
        return;
      }
      inflight.delete(sessionId);
      if (!sent.ok) {
        warn(`投递分诊会话失败：${sent.error}`);
        scheduleChat(chatId, 30_000);
      }
    } catch (error) {
      warn(`投递分诊会话失败：${errorMessage(error)}`);
    } finally {
      pumping.delete(chatId);
    }
  };

  const nextCardId = () => data.cards.reduce((max, card) => Math.max(max, card.id), 0) + 1;

  const addCard = (card: StoredCard) => {
    data.cards.push(card);
    if (data.cards.length > MAX_CARDS) data.cards.splice(0, data.cards.length - MAX_CARDS);
  };

  /** 整轮没有调用 triage_report：只在电脑上记一笔，群里不发 */
  const recordUnreported = (item: InflightItem) => {
    const text = item.texts.join('\n');
    warn(`分诊会话这一轮没有调用 triage_report（群 ${item.chatId}）`);
    if (item.cardId !== undefined) return;
    const group = groupOf(item.chatId);
    if (!group) return;
    const time = now();
    addCard({
      id: nextCardId(),
      chatId: item.chatId,
      workspaceId: group.workspaceId,
      status: 'unreported',
      title: text.replace(/\s+/g, ' ').slice(0, 80),
      summary: '',
      content: text.slice(0, ITEM_TEXT_MAX),
      messageId: item.replyTo,
      botMessageIds: [],
      followUps: 0,
      taskIds: [],
      createdAt: time,
      updatedAt: time,
    });
    commit();
  };

  const addCandidate = (chat: TgChat) => {
    const title = (chat.title ?? '').slice(0, 256);
    const existing = data.candidates.find((candidate) => candidate.chatId === chat.id);
    if (existing) {
      existing.title = title;
      existing.seenAt = now();
    } else {
      data.candidates.push({ chatId: chat.id, title, seenAt: now() });
      data.candidates.sort((a, b) => a.seenAt - b.seenAt);
      if (data.candidates.length > MAX_CANDIDATES) {
        data.candidates.splice(0, data.candidates.length - MAX_CANDIDATES);
      }
    }
    commit();
  };

  const migrateChat = (from: number, to: number) => {
    if (from === to) return;
    for (const group of data.groups) if (group.chatId === from) group.chatId = to;
    for (const candidate of data.candidates) if (candidate.chatId === from) candidate.chatId = to;
    for (const card of data.cards) if (card.chatId === from) card.chatId = to;
    const queue = queues.get(from);
    if (queue) {
      queues.delete(from);
      for (const item of queue) item.chatId = to;
      queues.set(to, queue);
    }
    for (const item of inflight.values()) if (item.chatId === from) item.chatId = to;
    commit();
  };

  const rateLimited = (userId: number, time: number): boolean => {
    const recent = (rate.get(userId) ?? []).filter((t) => t > time - HOUR_MS);
    if (recent.length >= RATE_LIMIT_PER_HOUR) {
      rate.set(userId, recent);
      return true;
    }
    recent.push(time);
    rate.set(userId, recent);
    return false;
  };

  const handleMessage = (message: TgMessage) => {
    const chat = message.chat;
    if (!isGroupChat(chat)) return; // 私聊与频道一律忽略，不回复
    if (message.migrate_to_chat_id !== undefined) {
      migrateChat(chat.id, message.migrate_to_chat_id);
      return;
    }
    if (message.migrate_from_chat_id !== undefined) {
      migrateChat(message.migrate_from_chat_id, chat.id);
      return;
    }
    const bot = data.bot;
    if (!bot) return;
    const group = groupOf(chat.id);
    if (!group) {
      // 未允许的群：只记为候选，消息丢弃
      addCandidate(chat);
      return;
    }
    if (!group.active) return;
    const from = message.from;
    const text = message.text;
    if (!from || from.is_bot || typeof text !== 'string') return; // 只取文字
    const repliedId =
      message.reply_to_message?.from?.id === bot.id
        ? message.reply_to_message.message_id
        : undefined;
    let body: string | null;
    let target: { cardId?: number; contextCardId?: number } = {};
    if (repliedId !== undefined) {
      body = parseBugCommand(text, bot.username) ?? text.trim();
      const card = data.cards.find(
        (c) => c.chatId === chat.id && c.botMessageIds.includes(repliedId)
      );
      if (card) {
        target = RETRIAGE_STATUSES.has(card.status)
          ? { cardId: card.id }
          : { contextCardId: card.id };
      }
    } else {
      body = parseBugCommand(text, bot.username);
    }
    if (!body) return;
    const time = message.date * 1000;
    if (rateLimited(from.id, time)) return;
    const queue = queues.get(chat.id) ?? [];
    const last = queue[queue.length - 1];
    if (
      last &&
      last.fromId === from.id &&
      last.cardId === target.cardId &&
      last.contextCardId === target.contextCardId &&
      time - last.lastDate <= DEBOUNCE_MS
    ) {
      // 同一人 3 秒内连续发的合成一条
      last.texts.push(body.slice(0, ITEM_TEXT_MAX));
      last.messageIds.push(message.message_id);
      last.lastDate = time;
      last.readyAt = now() + debounceMs;
    } else {
      queue.push({
        chatId: chat.id,
        ...target,
        fromId: from.id,
        sender: displayName(from),
        messageIds: [message.message_id],
        replyTo: message.message_id,
        texts: [body.slice(0, ITEM_TEXT_MAX)],
        lastDate: time,
        readyAt: now() + debounceMs,
      });
      if (queue.length > MAX_QUEUE_PER_GROUP) queue.splice(0, queue.length - MAX_QUEUE_PER_GROUP);
    }
    queues.set(chat.id, queue);
    scheduleChat(chat.id, debounceMs);
  };

  const handleUpdate = (update: TgUpdate) => {
    if (update.message) {
      handleMessage(update.message);
      return;
    }
    const member = update.my_chat_member;
    if (!member || !isGroupChat(member.chat)) return;
    const status = member.new_chat_member.status;
    const group = groupOf(member.chat.id);
    if (status === 'left' || status === 'kicked') {
      if (group) group.active = false;
      queues.delete(member.chat.id);
      data.candidates = data.candidates.filter((c) => c.chatId !== member.chat.id);
      commit();
      return;
    }
    if (group) {
      group.active = true;
      if (member.chat.title) group.title = member.chat.title.slice(0, 256);
      commit();
    } else {
      addCandidate(member.chat);
    }
  };

  // ---------- 轮询 ----------

  const pollLoop = async (signal: AbortSignal) => {
    const token = data.token;
    if (!token) return;
    let delay = 0;
    let ready = false;
    setConnection('connecting');
    while (!signal.aborted) {
      try {
        if (!ready) {
          data.bot = await deps.api.getMe(token, signal);
          ready = true;
          await deps.api
            .setMyCommands(token, signal)
            .catch((error) => warn(`注册 /bug 命令失败：${errorMessage(error)}`));
        }
        const updates = await deps.api.getUpdates(token, data.pollOffset, signal);
        if (signal.aborted) break;
        delay = 0;
        setConnection('connected');
        if (updates.length === 0) continue;
        // 先把 offset 落盘再处理：崩溃时宁可丢一批，不重复处理
        data.pollOffset = Math.max(...updates.map((update) => update.update_id)) + 1;
        await persist();
        for (const update of updates) {
          try {
            handleUpdate(update);
          } catch (error) {
            warn(`处理 update 失败：${errorMessage(error)}`);
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        const kind = error instanceof TelegramApiError ? error.kind : 'network';
        setConnection(
          kind === 'unauthorized'
            ? 'unauthorized'
            : kind === 'conflict'
              ? 'conflict'
              : kind === 'api'
                ? 'api-error'
                : 'network-error'
        );
        warn(`轮询失败：${errorMessage(error)}`);
        if (kind === 'unauthorized') break; // token 无效，等用户换 token
        delay = delay === 0 ? BACKOFF_START_MS : Math.min(delay * 2, BACKOFF_MAX_MS);
        await wait(delay, signal);
      }
    }
  };

  const startPolling = () => {
    if (poll || !data.enabled || !data.token) return;
    const controller = new AbortController();
    const done = pollLoop(controller.signal).catch((error) =>
      warn(`轮询意外退出：${errorMessage(error)}`)
    );
    poll = { controller, done };
  };

  const stopPolling = async () => {
    const current = poll;
    if (!current) return;
    poll = undefined;
    current.controller.abort();
    await current.done;
  };

  // ---------- triage_report ----------

  const knownSecrets = async (): Promise<readonly string[]> => {
    let known: readonly string[] = [];
    try {
      known = await deps.knownSecrets();
    } catch (error) {
      warn(`读取已知密钥失败：${errorMessage(error)}`);
    }
    cachedKnown = data.token ? [...known, data.token] : known;
    return cachedKnown;
  };

  const handleTriageReport = async (sessionId: string, input: unknown): Promise<HostCallResult> => {
    const group = groupOfSession(sessionId);
    if (!group) return { ok: false, error: 'not a registered triage session' };
    const item = inflight.get(sessionId);
    if (!item) return { ok: false, error: 'no pending item for this session' };
    if (item.reported) return { ok: false, error: 'already reported for this item' };
    const report = parseTriageInput(input);
    if (typeof report === 'string') return { ok: false, error: report };
    item.reported = true;
    const [ctx, known] = await Promise.all([
      deps.localInfo().catch((): LocalInfoContext => ({ paths: [] })),
      knownSecrets(),
    ]);
    const time = now();
    const clean = (text: string) => sanitizeLocalInfo(text, ctx);
    let card = item.cardId === undefined ? undefined : cardById(item.cardId);
    if (!card) {
      card = {
        id: nextCardId(),
        chatId: group.chatId,
        workspaceId: group.workspaceId,
        status: 'unreported',
        title: '',
        summary: '',
        content: item.texts.join('\n').slice(0, ITEM_TEXT_MAX),
        messageId: item.replyTo,
        botMessageIds: [],
        followUps: 0,
        taskIds: [],
        createdAt: time,
        updatedAt: time,
      };
      addCard(card);
    }
    card.kind = report.kind;
    card.title = clean(report.title);
    card.summary = clean(report.summary);
    card.updatedAt = time;
    delete card.evidence;
    delete card.assessment;
    delete card.assessmentIncomplete;
    if (report.evidence) card.evidence = clean(report.evidence);
    if (report.assessment) card.assessment = clean(report.assessment);
    const replyTo = item.replyTo;
    try {
      const followUp = report.needInfo || (report.kind === 'bug' && !report.evidence);
      if (followUp) {
        if (card.followUps >= MAX_FOLLOW_UPS) {
          card.status = 'unconfirmed';
          delete card.askedAt;
          await sendToGroup(card, TEMPLATES.closing, replyTo);
        } else {
          card.followUps += 1;
          card.status = 'asking';
          card.askedAt = time;
          await sendTriageReply(card, report.reply, replyTo, ctx, known);
        }
      } else if (report.kind === 'bug') {
        card.status = 'fixing';
        card.duty = 'queued';
        await sendTriageReply(card, report.reply, replyTo, ctx, known);
      } else if (report.kind === 'feature') {
        const verdict = parseAssessment(report.assessment);
        card.status = verdict === 'fail' ? 'declined' : 'pending-approval';
        if (verdict === 'incomplete') card.assessmentIncomplete = true;
        await sendTriageReply(card, report.reply, replyTo, ctx, known);
        if (card.status === 'pending-approval') {
          deps.notify(
            'Telegram 新的待确认需求',
            `卡片 #${card.id}：${card.title}${verdict === 'incomplete' ? '（评估格式不完整）' : ''}`
          );
        }
      } else {
        card.status = report.kind === 'question' ? 'answered' : 'invalid';
        if (report.reply) await sendTriageReply(card, report.reply, replyTo, ctx, known);
      }
    } catch (error) {
      warn(`处理 triage_report 失败（卡片 #${card.id}）：${errorMessage(error)}`);
    }
    commit();
    if (card.status === 'fixing') void pumpDuty(card.workspaceId);
    return { ok: true };
  };

  // ---------- 值班投递与卡片关联 ----------

  const coordinatorTaskIds = async (workspaceId: string, sessionId: string) => {
    const snapshot = await deps.snapshot(workspaceId);
    if (!snapshot) return undefined;
    const runIds = new Set(
      snapshot.runs.filter((run) => run.coordinatorSessionId === sessionId).map((run) => run.id)
    );
    return snapshot.tasks.filter((task) => runIds.has(task.runId)).map((task) => task.id);
  };

  const pumpDuty = async (workspaceId: string): Promise<void> => {
    if (dutyBusy.has(workspaceId) || dutyRounds.has(workspaceId)) return;
    const card = data.cards.find(
      (c) => c.workspaceId === workspaceId && c.status === 'fixing' && c.duty === 'queued'
    );
    if (!card) return;
    const workspace = deps.workspaces.get(workspaceId);
    if (!workspace) return;
    dutyBusy.add(workspaceId);
    try {
      const sessionId = await ensureDutySession(workspace);
      if (!sessionId || deps.agentHost.get(sessionId)?.status !== 'idle') return;
      await refreshCheckout(workspace);
      const known = await coordinatorTaskIds(workspaceId, sessionId).catch(() => undefined);
      dutyRounds.set(workspaceId, { cardId: card.id, sessionId, knownTaskIds: new Set(known) });
      const sent = await deps.agentHost.promptWhenIdle(sessionId, dutyPrompt(card));
      if (sent.ok && sent.delivered) {
        card.duty = 'sent';
        card.deliveredAt = now();
        card.updatedAt = now();
        commit();
        return;
      }
      dutyRounds.delete(workspaceId);
      if (!sent.ok) warn(`投递值班会话失败：${sent.error}`);
    } catch (error) {
      dutyRounds.delete(workspaceId);
      warn(`投递值班会话失败：${errorMessage(error)}`);
    } finally {
      dutyBusy.delete(workspaceId);
    }
  };

  /** 值班这一轮 settled：这一轮里新建的任务归到这张卡片 */
  const finishDutyRound = async (workspaceId: string, sessionId: string) => {
    dutySettledAt.set(sessionId, now());
    const round = dutyRounds.get(workspaceId);
    if (!round || round.sessionId !== sessionId) return;
    dutyRounds.delete(workspaceId);
    try {
      const card = cardById(round.cardId);
      const ids = await coordinatorTaskIds(workspaceId, sessionId);
      if (card && ids) {
        const owned = new Set(data.cards.flatMap((c) => c.taskIds));
        const fresh = ids.filter((id) => !round.knownTaskIds.has(id) && !owned.has(id));
        if (fresh.length > 0) {
          card.taskIds = [...card.taskIds, ...fresh].slice(0, 50);
          card.updatedAt = now();
          commit();
        }
      }
    } catch (error) {
      warn(`关联卡片任务失败：${errorMessage(error)}`);
    }
    await checkPullRequests(workspaceId);
    await pumpDuty(workspaceId);
  };

  const needsMaintainer = async (card: StoredCard, reason: string) => {
    card.status = 'needs-maintainer';
    card.updatedAt = now();
    await sendToGroup(card, TEMPLATES.needsMaintainer, card.messageId);
    deps.notify('Telegram 修复需要维护者处理', `卡片 #${card.id}：${card.title}（${reason}）`);
  };

  const checkPullRequests = async (workspaceId: string): Promise<void> => {
    const cards = data.cards.filter(
      (c) => c.workspaceId === workspaceId && c.status === 'fixing' && c.duty === 'sent'
    );
    if (cards.length === 0) return;
    let snapshot: Awaited<ReturnType<TelegramServiceDeps['snapshot']>>;
    try {
      snapshot = await deps.snapshot(workspaceId);
    } catch (error) {
      warn(`读取编排快照失败：${errorMessage(error)}`);
      return;
    }
    if (!snapshot) return;
    let changed = false;
    for (const card of cards) {
      if (card.status !== 'fixing') continue;
      const tasks = snapshot.tasks.filter((task) => card.taskIds.includes(task.id));
      const url = tasks.find((task) => task.pullRequest)?.pullRequest?.url;
      if (url && /^https:\/\/\S+$/.test(url)) {
        card.status = 'pr-opened';
        card.prUrl = url;
        card.updatedAt = now();
        changed = true;
        await sendToGroup(card, TEMPLATES.prOpened(url), card.messageId);
        deps.notify('Telegram 修复 PR 已开', `卡片 #${card.id}：${card.title}\n${url}`);
        continue;
      }
      if (
        tasks.length > 0 &&
        tasks.every((t) => t.status === 'failed' || t.status === 'abandoned')
      ) {
        changed = true;
        await needsMaintainer(card, '任务失败或已放弃');
        continue;
      }
      if (dutyRounds.get(workspaceId)?.cardId === card.id) continue;
      const dutyId = data.workspaces[workspaceId]?.dutySessionId;
      const status = dutyId ? deps.agentHost.get(dutyId)?.status : undefined;
      const busy = status === 'running' || status === 'waiting-approval';
      const since = Math.max(card.deliveredAt ?? 0, (dutyId && dutySettledAt.get(dutyId)) || 0);
      if (
        !busy &&
        now() - since >= DUTY_IDLE_MS &&
        !tasks.some((t) => OPEN_TASK_STATUSES.has(t.status))
      ) {
        changed = true;
        await needsMaintainer(card, '值班会话空闲 30 分钟仍没有 PR');
      }
    }
    if (changed) commit();
  };

  // ---------- 事件订阅 ----------

  const onSessionIdle = (sessionId: string) => {
    const group = groupOfSession(sessionId);
    if (group) void pumpChat(group.chatId);
    const workspaceId = workspaceOfDuty(sessionId);
    if (workspaceId) void pumpDuty(workspaceId);
  };

  const onSettled = (sessionId: string) => {
    const group = groupOfSession(sessionId);
    if (group) {
      const item = inflight.get(sessionId);
      if (item) {
        inflight.delete(sessionId);
        if (!item.reported) recordUnreported(item);
      }
      void pumpChat(group.chatId);
    }
    const workspaceId = workspaceOfDuty(sessionId);
    if (workspaceId) void finishDutyRound(workspaceId, sessionId);
  };

  // ---------- 对外接口 ----------

  const view = (): TelegramStateView => ({
    enabled: data.enabled,
    connection: poll ? connection : idleConnection(),
    ...(data.token ? { tokenMasked: maskTelegramToken(data.token) } : {}),
    ...(data.bot ? { bot: { ...data.bot } } : {}),
    candidates: data.candidates.map((c) => ({ ...c })),
    groups: data.groups.map((g) => ({ ...g })),
    cards: [...data.cards].reverse().map((card) => ({
      id: card.id,
      chatId: card.chatId,
      groupTitle: groupOf(card.chatId)?.title ?? '',
      workspaceId: card.workspaceId,
      ...(card.kind ? { kind: card.kind } : {}),
      status: card.status,
      title: card.title,
      summary: card.summary,
      ...(card.evidence ? { evidence: card.evidence } : {}),
      ...(card.assessment ? { assessment: card.assessment } : {}),
      ...(card.assessmentIncomplete ? { assessmentIncomplete: true } : {}),
      followUps: card.followUps,
      taskIds: [...card.taskIds],
      ...(card.prUrl ? { prUrl: card.prUrl } : {}),
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    })),
  });

  return {
    async start() {
      data = await deps.store.load();
      connection = idleConnection();
      unregisterSecret = registerSecretSource('telegram', () => (data.token ? [data.token] : []));
      unobserve = deps.agentHost.observe({
        event: ({ sessionId, event }) => {
          if (event.type === 'agent_settled') onSettled(sessionId);
        },
        activity: (sessionId, action) => {
          if (action === 'idle') onSessionIdle(sessionId);
        },
      });
      maintenanceTimer = setInterval(() => void maintain(), MAINTENANCE_INTERVAL_MS);
      maintenanceTimer.unref?.();
      startPolling();
      void maintain();
    },
    async stop() {
      clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
      for (const timer of [...chatTimers.values(), ...prChecks.values()]) clearTimeout(timer);
      chatTimers.clear();
      prChecks.clear();
      unobserve?.();
      unobserve = undefined;
      await stopPolling();
      unregisterSecret?.();
      unregisterSecret = undefined;
      await lastWrite;
    },
    getState: view,
    async setToken(token) {
      if (token === null) {
        await stopPolling();
        delete data.token;
        delete data.bot;
        data.pollOffset = 0;
        connection = idleConnection();
        await persist().catch(() => undefined);
        emit();
        return { ok: true };
      }
      if (typeof token !== 'string' || !TELEGRAM_TOKEN_PATTERN.test(token)) {
        return { ok: false, error: 'Bot Token 格式不对' };
      }
      let bot: { id: number; username: string };
      try {
        bot = await deps.api.getMe(token);
      } catch (error) {
        const kind = error instanceof TelegramApiError ? error.kind : 'network';
        return {
          ok: false,
          error:
            kind === 'unauthorized'
              ? 'Telegram 拒绝了这个 token'
              : kind === 'network'
                ? redactToken(
                    `连不上 api.telegram.org（${errorMessage(error).replace(/^getMe:\s*/, '')}）：请确认 VPN 或代理已开启；网络代理默认跟随系统代理，也可以在「设置 → 通用 → 网络代理」改用手动代理`,
                    token
                  )
                : redactToken(`验证 token 失败：${errorMessage(error)}`, token),
        };
      }
      await stopPolling();
      if (data.token !== token) data.pollOffset = 0;
      data.token = token;
      data.bot = bot;
      connection = idleConnection();
      try {
        await persist();
      } catch (error) {
        return { ok: false, error: safe(`保存失败：${errorMessage(error)}`) };
      }
      startPolling();
      emit();
      return { ok: true };
    },
    async allowGroup(chatId, workspaceId) {
      const candidate = data.candidates.find((c) => c.chatId === chatId);
      if (!candidate) return { ok: false, error: '只能允许候选群' };
      if (groupOf(chatId)) return { ok: false, error: '这个群已经允许过' };
      const workspace = deps.workspaces.get(workspaceId);
      if (!workspace) return { ok: false, error: '工作区不存在' };
      if (workspace.vcs !== 'git' || !workspace.defaultBranch) {
        return { ok: false, error: '只能绑定有默认分支的 git 工作区' };
      }
      const origin = await deps.cleanCheckout.originCommit(workspace);
      if (!origin.ok) return { ok: false, error: `没有远端分支：${origin.error}` };
      const created = await createTriageSession(workspace, candidate.title);
      if (!created.ok) return created;
      data.workspaces[workspaceId] = {
        ...data.workspaces[workspaceId],
        cleanCheckoutPath: created.path,
      };
      data.groups.push({
        chatId,
        title: candidate.title,
        workspaceId,
        triageSessionId: created.sessionId,
        active: true,
      });
      data.candidates = data.candidates.filter((c) => c.chatId !== chatId);
      commit();
      return { ok: true };
    },
    async removeGroup(chatId) {
      const group = groupOf(chatId);
      if (!group) return { ok: false, error: '群不存在' };
      data.groups = data.groups.filter((g) => g.chatId !== chatId);
      queues.delete(chatId);
      inflight.delete(group.triageSessionId);
      if (group.active) {
        data.candidates.push({ chatId, title: group.title, seenAt: now() });
        if (data.candidates.length > MAX_CANDIDATES) data.candidates.shift();
      }
      commit();
      return { ok: true };
    },
    async resolveCard(cardId, action) {
      const card = cardById(cardId);
      if (card?.status !== 'pending-approval') {
        return { ok: false, error: '只能处理待确认的需求' };
      }
      card.updatedAt = now();
      if (action === 'approve') {
        card.status = 'fixing';
        card.duty = 'queued';
        commit();
        void pumpDuty(card.workspaceId);
        return { ok: true };
      }
      card.status = 'rejected';
      await sendToGroup(card, TEMPLATES.rejected, card.messageId);
      commit();
      return { ok: true };
    },
    async setEnabled(enabled) {
      data.enabled = enabled;
      if (!enabled) await stopPolling();
      connection = idleConnection();
      try {
        await persist();
      } catch (error) {
        return { ok: false, error: safe(`保存失败：${errorMessage(error)}`) };
      }
      startPolling();
      emit();
      return { ok: true };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async invoke(sessionId, method, input) {
      if (method !== 'triageReport') return { ok: false, error: `unknown method: ${method}` };
      try {
        return await handleTriageReport(sessionId, input);
      } catch (error) {
        return { ok: false, error: safe(errorMessage(error)) };
      }
    },
    orchestrationChanged(workspaceId) {
      if (prChecks.has(workspaceId)) return;
      prChecks.set(
        workspaceId,
        setTimeout(() => {
          prChecks.delete(workspaceId);
          void checkPullRequests(workspaceId);
        }, 300)
      );
    },
    pullRequestBodyExtension(taskId) {
      const card = data.cards.find((c) => c.taskIds.includes(taskId));
      if (!card) return undefined;
      const section = pullRequestSection(card);
      // 万一卡片标题 / 摘要里有密钥，只留来源
      return scanSecrets(section, cachedKnown).hit
        ? `## 来源\n\nTelegram 群反馈（卡片 #${card.id}）`
        : section;
    },
    maintain,
  };

  async function maintain(): Promise<void> {
    {
      const time = now();
      let changed = false;
      for (const card of data.cards) {
        // 追问 24 小时没人回复：记为未确认，群里不再发消息
        if (
          card.status === 'asking' &&
          time - (card.askedAt ?? card.updatedAt) >= FOLLOW_UP_TIMEOUT_MS
        ) {
          card.status = 'unconfirmed';
          card.updatedAt = time;
          delete card.askedAt;
          changed = true;
        }
      }
      if (changed) commit();
      const workspaceIds = new Set(
        data.cards.filter((c) => c.status === 'fixing').map((c) => c.workspaceId)
      );
      for (const workspaceId of workspaceIds) {
        await checkPullRequests(workspaceId);
        await pumpDuty(workspaceId);
      }
      for (const chatId of queues.keys()) void pumpChat(chatId);
    }
  }
}
