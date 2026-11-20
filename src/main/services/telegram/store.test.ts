import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramStore, emptyTelegramData, MAX_CARDS, parseTelegramData } from './store';

const TOKEN = `123456789:${'A'.repeat(35)}`;
let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('telegram store', () => {
  it('非法字段与记录只丢弃自己', () => {
    const data = parseTelegramData({
      enabled: true,
      token: 'not-a-token',
      bot: { id: 'x' },
      candidates: [{ chatId: -1, title: 'ok', seenAt: 1 }, { chatId: 'bad' }],
      groups: [
        { chatId: -2, title: 'g', workspaceId: 'ws1', triageSessionId: 's1', active: true },
        { chatId: -3, title: 'bad', workspaceId: '../x', triageSessionId: 's2' },
      ],
      workspaces: { ws1: { cleanCheckoutPath: '/tmp/c', dutySessionId: 'd1' }, ws2: { foo: 1 } },
      cards: [{ id: 1 }, 'junk'],
      pollOffset: -5,
    });
    expect(data.enabled).toBe(true);
    expect(data.token).toBeUndefined();
    expect(data.bot).toBeUndefined();
    expect(data.candidates).toEqual([{ chatId: -1, title: 'ok', seenAt: 1 }]);
    expect(data.groups.map((g) => g.chatId)).toEqual([-2]);
    expect(Object.keys(data.workspaces)).toEqual(['ws1']);
    expect(data.cards).toEqual([]);
    expect(data.pollOffset).toBe(0);
  });

  it('rateLimitPerHour 缺失或非法时按 5，合法时保留', () => {
    for (const bad of [undefined, 0, 1001, 1.5, '10', null]) {
      expect(parseTelegramData({ rateLimitPerHour: bad }).rateLimitPerHour).toBe(5);
    }
    expect(parseTelegramData({ rateLimitPerHour: 1 }).rateLimitPerHour).toBe(1);
    expect(parseTelegramData({ rateLimitPerHour: 1000 }).rateLimitPerHour).toBe(1000);
  });

  it('卡片只保留最近 500 张', () => {
    const cards = Array.from({ length: MAX_CARDS + 3 }, (_, i) => ({
      id: i + 1,
      chatId: -1,
      workspaceId: 'ws1',
      status: 'answered',
      messageId: 1,
      createdAt: 1,
    }));
    const data = parseTelegramData({ cards });
    expect(data.cards).toHaveLength(MAX_CARDS);
    expect(data.cards[0]?.id).toBe(4);
  });

  it('原子写后能读回；坏 JSON 改名留底', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-store-'));
    const file = join(dir, 'telegram.json');
    const store = createTelegramStore(file, () => 7);
    expect(await store.load()).toEqual(emptyTelegramData());
    await store.save({ ...emptyTelegramData(), token: TOKEN, pollOffset: 12 });
    const loaded = await store.load();
    expect(loaded.token).toBe(TOKEN);
    expect(loaded.pollOffset).toBe(12);

    await writeFile(file, '{oops');
    expect(await store.load()).toEqual(emptyTelegramData());
    expect(await readFile(`${file}.corrupt-7`, 'utf8')).toBe('{oops');
  });
});
