/**
 * `@electron-toolkit/utils` 桩：真包顶层 require('electron')，绕开了 vitest 的 electron alias，
 * 在 node 环境会让间接 import 它的 Main 模块全部加载失败。
 */
export const is = { dev: false };
export const electronApp = { setAppUserModelId: () => {} };
export const optimizer = { watchWindowShortcuts: () => {} };
