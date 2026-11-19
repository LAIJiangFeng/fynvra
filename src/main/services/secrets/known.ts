// 已知密钥的收集：值只在 Main 内存里用于精确匹配，不进任何日志、错误或返回给 Renderer。

/** 去首尾空白后短于此长度的值不收录，避免误报 */
export const MIN_SECRET_LENGTH = 8;
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

const extraSources = new Map<string, () => readonly string[]>();

/** 注册额外的已知密钥来源（如 telegram token）；同 id 覆盖。返回注销函数。 */
export function registerSecretSource(id: string, read: () => readonly string[]): () => void {
  extraSources.set(id, read);
  return () => {
    if (extraSources.get(id) === read) extraSources.delete(id);
  };
}

export interface KnownSecretSources {
  providers?: { list(): Promise<readonly { apiKey?: string }[]> };
  mcp?: {
    list(): Promise<readonly { env?: Record<string, string>; headers?: Record<string, string> }[]>;
  };
  env?: NodeJS.ProcessEnv;
}

/** 收集已知密钥：服务 apiKey、MCP env / headers 值、名字像密钥的环境变量、注册的来源。读取失败照常抛出（调用方拒绝推送）。 */
export async function collectKnownSecrets(sources: KnownSecretSources): Promise<string[]> {
  const values: (string | undefined)[] = [];
  for (const provider of (await sources.providers?.list()) ?? []) values.push(provider.apiKey);
  for (const server of (await sources.mcp?.list()) ?? []) {
    values.push(...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {}));
  }
  for (const [name, value] of Object.entries(sources.env ?? {})) {
    if (SECRET_ENV_NAME.test(name)) values.push(value);
  }
  for (const read of extraSources.values()) values.push(...read());
  const kept = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_SECRET_LENGTH);
  return [...new Set(kept)];
}

/** 生产用：从 Main 唯一的 providers.json / mcp.json 句柄与 process.env 收集（动态 import，测试不加载 Electron）。 */
export async function collectAppSecrets(): Promise<string[]> {
  const [{ getProviderStore }, { getMcpRegistry }] = await Promise.all([
    import('../../ipc/providers'),
    import('../../ipc/mcp'),
  ]);
  return collectKnownSecrets({
    providers: getProviderStore(),
    mcp: getMcpRegistry(),
    env: process.env,
  });
}
