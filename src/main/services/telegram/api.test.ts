import { describe, expect, it, vi } from 'vitest';
import { createTelegramApi, type HttpPost, redactToken, TelegramApiError } from './api';

const TOKEN = `123456789:${'A'.repeat(35)}`;

function fakeHttp(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body: unknown }[] = [];
  const http: HttpPost = async (url, body) => {
    calls.push({ url, body });
    const next = responses.shift();
    if (!next) throw new Error(`connect ECONNREFUSED ${url}`);
    return next;
  };
  return { http, calls };
}

async function caught(promise: Promise<unknown>): Promise<TelegramApiError> {
  try {
    await promise;
  } catch (error) {
    return error as TelegramApiError;
  }
  throw new Error('expected rejection');
}

describe('telegram api', () => {
  it('getUpdates 用长轮询并只收 message 与 my_chat_member', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { ok: true, result: [{ update_id: 5 }] } },
    ]);
    const api = createTelegramApi({ http });
    expect(await api.getUpdates(TOKEN, 3)).toEqual([{ update_id: 5 }]);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[0]?.body).toEqual({
      offset: 3,
      timeout: 30,
      allowed_updates: ['message', 'my_chat_member'],
    });
  });

  it('sendMessage 纯文本、回复原消息、关闭链接预览', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { ok: true, result: { message_id: 9 } } },
    ]);
    const api = createTelegramApi({ http });
    expect(await api.sendMessage(TOKEN, { chatId: -1, text: 'hi', replyTo: 7 })).toEqual({
      messageId: 9,
    });
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.parse_mode).toBeUndefined();
    expect(body.reply_parameters).toMatchObject({ message_id: 7 });
    expect(body.link_preview_options).toEqual({ is_disabled: true });
  });

  it('setMyCommands 只注册 /bug，作用域为群聊', async () => {
    const { http, calls } = fakeHttp([{ status: 200, body: { ok: true, result: true } }]);
    await createTelegramApi({ http }).setMyCommands(TOKEN);
    expect(calls[0]?.body).toMatchObject({
      commands: [{ command: 'bug' }],
      scope: { type: 'all_group_chats' },
    });
  });

  it('429 按 retry_after 等待后重试一次', async () => {
    const sleep = vi.fn(async () => undefined);
    const { http, calls } = fakeHttp([
      { status: 429, body: { ok: false, parameters: { retry_after: 2 } } },
      { status: 200, body: { ok: true, result: [] } },
    ]);
    await createTelegramApi({ http, sleep }).getUpdates(TOKEN, 0);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(calls).toHaveLength(2);

    const twice = fakeHttp([
      { status: 429, body: { ok: false, parameters: { retry_after: 1 } } },
      { status: 429, body: { ok: false, parameters: { retry_after: 1 } } },
    ]);
    const error = await caught(createTelegramApi({ http: twice.http, sleep }).getUpdates(TOKEN, 0));
    expect(error.kind).toBe('api');
    expect(twice.calls).toHaveLength(2);
  });

  it('401 / 409 / 网络错误分类，错误文本不含 token', async () => {
    const cases = [
      [{ status: 401, body: { ok: false, description: `Unauthorized ${TOKEN}` } }, 'unauthorized'],
      [
        {
          status: 409,
          body: { ok: false, description: 'Conflict: terminated by other getUpdates' },
        },
        'conflict',
      ],
      [{ status: 400, body: { ok: false, description: 'Bad Request' } }, 'api'],
    ] as const;
    for (const [response, kind] of cases) {
      const { http } = fakeHttp([response]);
      const error = await caught(createTelegramApi({ http }).getUpdates(TOKEN, 0));
      expect(error).toBeInstanceOf(TelegramApiError);
      expect(error.kind).toBe(kind);
      expect(error.message).not.toContain(TOKEN);
    }
    // 网络错误的文本里带了完整 URL（含 token）
    const { http } = fakeHttp([]);
    const error = await caught(createTelegramApi({ http }).getMe(TOKEN));
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('<token>');
  });

  it('redactToken 打码已知 token 与任何像 token 的串', () => {
    expect(redactToken(`a ${TOKEN} b`, TOKEN)).toBe('a <token> b');
    expect(redactToken(`x 987654321:${'b'.repeat(35)}`)).toBe('x <token>');
  });
});
