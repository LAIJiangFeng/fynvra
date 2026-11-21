// 宿主 API 方法表：白名单就是这张表的键。每个方法写明所需权限与入参收窄函数（见 ./types）。
// 扩展点：H2 / H3 各新建一个模块（如 api/ui.ts、api/channel.ts），导出 `XXX_API: Record<string, ApiMethod>`
// 与依赖接口 `XxxApiDeps`，再在这里并进 API_METHODS 与 ApiDeps。方法名用 `<模块>.<动作>`。
import { BASE_API, type BaseApiDeps } from './base';
import type { ApiMethod } from './types';
import { UI_API, type UiApiDeps } from './ui';

export type { ApiContext, ApiMethod } from './types';
export { defineMethod } from './types';

/** 各模块依赖的并集（H2 / H3 在此加 `& UiApiDeps & ChannelApiDeps`） */
export type ApiDeps = BaseApiDeps & UiApiDeps;

export const API_METHODS: Readonly<Record<string, ApiMethod>> = Object.freeze({
  ...BASE_API,
  ...UI_API,
});
