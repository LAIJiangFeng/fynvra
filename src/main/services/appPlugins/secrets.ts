// Fynvra 插件密钥 `userData/fynvra-plugin-secrets.json`：按插件隔离，权限 0600（writeJsonAtomic），
// 值登记为已知密钥（registerSecretSource('plugin:<id>')），出站过滤与日志脱敏都能认出来。
import { readFile, rename } from 'node:fs/promises';
import { asRecord } from '@shared/guards';
import { writeJsonAtomic } from '../providers/jsonRegistry';
import { registerSecretSource } from '../secrets';

export const SECRET_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_SECRET_VALUE_BYTES = 4 * 1024;

export interface PluginSecretStore {
  get(pluginId: string, key: string): Promise<string | null>;
  set(pluginId: string, key: string, value: string | null): Promise<void>;
  /** 某插件全部密钥值（日志脱敏用；未加载时为空） */
  values(pluginId: string): string[];
  /** 删除某插件的全部密钥并注销已知密钥来源 */
  removePlugin(pluginId: string): Promise<void>;
  /** 读文件并为已有的插件登记已知密钥来源 */
  load(): Promise<void>;
}

type Data = Record<string, Record<string, string>>;

export function createPluginSecretStore(deps: {
  filePath: string;
  register?: typeof registerSecretSource;
  now?: () => number;
}): PluginSecretStore {
  const { filePath, register = registerSecretSource, now = Date.now } = deps;
  let data: Data | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const unregister = new Map<string, () => void>();

  const values = (pluginId: string) => Object.values(data?.[pluginId] ?? {});

  function track(pluginId: string): void {
    if (unregister.has(pluginId)) return;
    unregister.set(
      pluginId,
      register(`plugin:${pluginId}`, () => values(pluginId))
    );
  }

  async function load(): Promise<Data> {
    if (data) return data;
    let parsed: Data = {};
    try {
      const record = asRecord(JSON.parse(await readFile(filePath, 'utf8')));
      const plugins = asRecord(record?.plugins);
      if (record?.version !== 1 || !plugins) throw new Error('corrupt');
      for (const [id, raw] of Object.entries(plugins)) {
        const entries = Object.entries(asRecord(raw) ?? {}).filter(
          (entry): entry is [string, string] =>
            SECRET_KEY.test(entry[0]) && typeof entry[1] === 'string'
        );
        if (entries.length > 0) parsed[id] = Object.fromEntries(entries);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rename(filePath, `${filePath}.corrupt-${now()}`).catch(() => undefined);
        console.warn('[appPlugins] fynvra-plugin-secrets.json unreadable, moved aside');
      }
      parsed = {};
    }
    data = parsed;
    for (const id of Object.keys(parsed)) track(id);
    return data;
  }

  function mutate(change: (current: Data) => Data): Promise<void> {
    const run = queue.then(async () => {
      const next = change(structuredClone(await load()));
      await writeJsonAtomic(filePath, { version: 1, plugins: next });
      data = next;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async load() {
      await load();
    },
    async get(pluginId, key) {
      await queue;
      return (await load())[pluginId]?.[key] ?? null;
    },
    set(pluginId, key, value) {
      if (!SECRET_KEY.test(key)) return Promise.reject(new Error('invalid secret key'));
      if (value !== null && new TextEncoder().encode(value).length > MAX_SECRET_VALUE_BYTES) {
        return Promise.reject(new Error('secret value too large'));
      }
      return mutate((current) => {
        const own = { ...(current[pluginId] ?? {}) };
        if (value === null) delete own[key];
        else own[key] = value;
        if (Object.keys(own).length > 0) current[pluginId] = own;
        else delete current[pluginId];
        return current;
      }).then(() => track(pluginId));
    },
    values,
    async removePlugin(pluginId) {
      await mutate((current) => {
        delete current[pluginId];
        return current;
      });
      unregister.get(pluginId)?.();
      unregister.delete(pluginId);
    },
  };
}
