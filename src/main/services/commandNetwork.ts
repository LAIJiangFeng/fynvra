import {
  commandEnvironment,
  DEFAULT_NETWORK_PROXY,
  type NetworkProxy,
  type ResolvedNetworkProxy,
  resolveNetworkProxy,
} from '@shared/networkProxy';
import { getSystemProxy } from './systemProxy';

let readConfiguration: () => NetworkProxy | undefined = () => undefined;

/** Main wires the settings reader at startup; commands read it again on every spawn. */
export function configureCommandNetwork(read: () => NetworkProxy | undefined): void {
  readConfiguration = read;
}

/** 当前设置 + 缓存的系统代理检测结果；未保存设置时按默认（跟随系统代理） */
export function savedNetworkProxy(): ResolvedNetworkProxy {
  return resolveNetworkProxy(
    readConfiguration(),
    getSystemProxy()?.current() ?? { kind: 'unknown' }
  );
}

export function savedCommandEnvironment(): NodeJS.ProcessEnv {
  return commandEnvironment(process.env, savedNetworkProxy(), process.platform === 'win32');
}

/** 插件与市场每次联网前用：system 模式下缓存超过 5 秒先刷新再算环境 */
export async function freshCommandEnvironment(): Promise<NodeJS.ProcessEnv> {
  if ((readConfiguration() ?? DEFAULT_NETWORK_PROXY).mode === 'system') {
    await getSystemProxy()?.fresh();
  }
  return savedCommandEnvironment();
}
