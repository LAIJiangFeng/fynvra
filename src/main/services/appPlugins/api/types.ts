import type { AppPluginPermission } from '@shared/types/appPlugins';
import type { ApiDeps } from './index';

/** 一次调用的上下文：哪个插件、它的私有数据目录、Main 注入的依赖 */
export interface ApiContext {
  pluginId: string;
  dataDir: string;
  deps: ApiDeps;
}

/** 宿主 API 的一个方法：所需权限（缺省无需权限）、入参从 unknown 收窄（非法返回 null）、执行 */
export interface ApiMethod<P = unknown> {
  permission?: AppPluginPermission;
  parse(raw: unknown): P | null;
  run(ctx: ApiContext, params: P): unknown;
}

/** 擦掉入参类型放进方法表（parse 与 run 的类型在定义处已对上） */
export function defineMethod<P>(method: ApiMethod<P>): ApiMethod {
  return method as unknown as ApiMethod;
}
