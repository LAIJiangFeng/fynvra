// Telegram Bot API 客户端（ARCHITECTURE §7.14）：HTTP 可注入；token 与带 token 的 URL 绝不进日志、错误与返回值。
import { Agent, request } from 'node:https';
import { asRecord, errorMessage } from '@shared/guards';
import { disablesNodeTlsVerification } from '../networkTest';

export type TelegramErrorKind = 'network' | 'unauthorized' | 'conflict' | 'api';

/** Bot token 的格式（同 secrets 的检测规则） */
export const TELEGRAM_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{35}$/;
const TOKEN_ANYWHERE = /\d{6,12}:[A-Za-z0-9_-]{35}/g;

/** 把文本里的 token 打码（含已知 token 与任何像 token 的串）。 */
export function redactToken(text: string, token?: string): string {
  let out = token ? text.split(token).join('<token>') : text;
  out = out.replace(TOKEN_ANYWHERE, '<token>');
  return out;
}

export class TelegramApiError extends Error {
  constructor(
    readonly kind: TelegramErrorKind,
    message: string,
    readonly retryAfterSec?: number
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** POST JSON；网络失败时 reject。实现方不要把 url 写进错误（调用方仍会打码）。 */
export type HttpPost = (
  url: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs: number }
) => Promise<HttpResponse>;

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: { message_id: number; from?: TgUser };
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  new_chat_member: { status: string; user: TgUser };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: TgChatMemberUpdated;
}

export interface TelegramApi {
  getMe(token: string, signal?: AbortSignal): Promise<{ id: number; username: string }>;
  getUpdates(token: string, offset: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(
    token: string,
    input: { chatId: number; text: string; replyTo?: number },
    signal?: AbortSignal
  ): Promise<{ messageId: number }>;
  setMyCommands(token: string, signal?: AbortSignal): Promise<void>;
}

const API_BASE = 'https://api.telegram.org';
export const LONG_POLL_TIMEOUT_SEC = 30;
const REQUEST_TIMEOUT_MS = 20_000;
/** 429 最多等这么久再重试；更长的直接报错 */
const MAX_RETRY_AFTER_SEC = 60;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TelegramApiError('network', 'aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TelegramApiError('network', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface TelegramApiOptions {
  http?: HttpPost;
  /** 测试注入，缺省真实等待 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createTelegramApi(options: TelegramApiOptions = {}): TelegramApi {
  const http = options.http ?? createHttpsPost(() => process.env);
  const wait = options.sleep ?? sleep;

  async function call(
    token: string,
    method: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      let response: HttpResponse;
      try {
        response = await http(`${API_BASE}/bot${token}/${method}`, body, { signal, timeoutMs });
      } catch (error) {
        throw new TelegramApiError(
          'network',
          redactToken(`${method}: ${errorMessage(error)}`, token)
        );
      }
      const record = asRecord(response.body);
      if (response.status === 200 && record?.ok === true) return record.result;
      const description = typeof record?.description === 'string' ? record.description : '';
      const text = redactToken(
        `${method}: HTTP ${response.status}${description ? ` ${description}` : ''}`,
        token
      );
      if (response.status === 401) throw new TelegramApiError('unauthorized', text);
      if (response.status === 409) throw new TelegramApiError('conflict', text);
      if (response.status === 429) {
        const retryAfter = asRecord(record?.parameters)?.retry_after;
        const seconds = typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : 1;
        if (attempt === 0 && seconds <= MAX_RETRY_AFTER_SEC) {
          await wait(seconds * 1000, signal);
          continue;
        }
        throw new TelegramApiError('api', text, seconds);
      }
      throw new TelegramApiError('api', text);
    }
  }

  return {
    async getMe(token, signal) {
      const user = asRecord(await call(token, 'getMe', {}, signal));
      if (typeof user?.id !== 'number' || typeof user.username !== 'string') {
        throw new TelegramApiError('api', 'getMe: unexpected response');
      }
      return { id: user.id, username: user.username };
    },
    async getUpdates(token, offset, signal) {
      const result = await call(
        token,
        'getUpdates',
        {
          offset,
          timeout: LONG_POLL_TIMEOUT_SEC,
          allowed_updates: ['message', 'my_chat_member'],
        },
        signal,
        (LONG_POLL_TIMEOUT_SEC + 15) * 1000
      );
      if (!Array.isArray(result))
        throw new TelegramApiError('api', 'getUpdates: unexpected response');
      return result.filter(
        (item): item is TgUpdate => typeof asRecord(item)?.update_id === 'number'
      );
    },
    async sendMessage(token, input, signal) {
      const result = asRecord(
        await call(
          token,
          'sendMessage',
          {
            chat_id: input.chatId,
            text: input.text,
            link_preview_options: { is_disabled: true },
            ...(input.replyTo === undefined
              ? {}
              : {
                  reply_parameters: {
                    message_id: input.replyTo,
                    allow_sending_without_reply: true,
                  },
                }),
          },
          signal
        )
      );
      if (typeof result?.message_id !== 'number') {
        throw new TelegramApiError('api', 'sendMessage: unexpected response');
      }
      return { messageId: result.message_id };
    },
    async setMyCommands(token, signal) {
      await call(
        token,
        'setMyCommands',
        {
          commands: [{ command: 'bug', description: '反馈 bug 或需求' }],
          scope: { type: 'all_group_chats' },
        },
        signal
      );
    },
  };
}

/** 生产用：照 networkTest 的写法走 §7.7 代理（每次请求现读环境）；错误文本不含 url。 */
export function createHttpsPost(
  env: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>,
  nodeVersion: string = process.versions.node
): HttpPost {
  return (url, body, { signal, timeoutMs }) =>
    Promise.resolve(env()).then(
      (current) =>
        new Promise((resolve, reject) => {
          // 代理握手不继承请求的 rejectUnauthorized：TLS 校验被全局关掉时不发 token
          if (disablesNodeTlsVerification(current) || disablesNodeTlsVerification(process.env)) {
            reject(
              new TelegramApiError(
                'network',
                'NODE_TLS_REJECT_UNAUTHORIZED=0 关闭了 TLS 校验，已拒绝连接'
              )
            );
            return;
          }
          // 同 networkTest：proxyEnv 需 Node 24.5+ / 22.21+，旧版本配了代理也不能悄悄直连
          const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
          const supportsProxyEnv =
            major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
          if (
            !supportsProxyEnv &&
            (current.HTTPS_PROXY || current.https_proxy || current.ALL_PROXY || current.all_proxy)
          ) {
            reject(
              new TelegramApiError(
                'network',
                `当前 Node ${nodeVersion} 不支持 proxyEnv，配置的代理无法生效，已拒绝直连`
              )
            );
            return;
          }
          const proxyEnv = { ...current };
          if (!proxyEnv.https_proxy && !proxyEnv.HTTPS_PROXY) {
            proxyEnv.HTTPS_PROXY = proxyEnv.all_proxy || proxyEnv.ALL_PROXY;
          }
          const agent = new Agent({ proxyEnv, rejectUnauthorized: true });
          const payload = JSON.stringify(body);
          const done = (error?: Error, response?: HttpResponse) => {
            agent.destroy();
            if (error) reject(error);
            else if (response) resolve(response);
          };
          try {
            const req = request(
              url,
              {
                method: 'POST',
                agent,
                signal,
                timeout: timeoutMs,
                rejectUnauthorized: true,
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                },
              },
              (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > 8 * 1024 * 1024) {
                    res.destroy();
                    done(new Error('response too large'));
                    return;
                  }
                  chunks.push(chunk);
                });
                res.on('end', () => {
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                  } catch {
                    parsed = undefined;
                  }
                  done(undefined, { status: res.statusCode ?? 0, body: parsed });
                });
                res.on('error', () => done(new Error('response error')));
              }
            );
            req.on('timeout', () => req.destroy(new Error('request timed out')));
            // 只取错误码，Node 的错误文本可能带主机与路径
            req.on('error', (error: NodeJS.ErrnoException) =>
              done(new Error(error.code ?? (signal?.aborted ? 'aborted' : 'request failed')))
            );
            req.end(payload);
          } catch (error) {
            done(new Error((error as NodeJS.ErrnoException).code ?? 'request failed'));
          }
        })
    );
}
