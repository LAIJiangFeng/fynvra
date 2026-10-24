/**
 * 测试用 electron 桩：node 环境解析不了真实的 electron 包，
 * 这里给出 Main 模块顶层会用到的最小形状。需要断言行为的用例自己 vi.mock('electron')。
 */
export const app = {
  isPackaged: false,
  getPath: (name: string) => `/tmp/fynvra-test/${name}`,
  setPath: () => {},
  on: () => {},
  quit: () => {},
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
};

export const ipcMain = {
  handle: () => {},
  removeHandler: () => {},
};

export const BrowserWindow = {
  getAllWindows: () => [],
  fromWebContents: () => null,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export const nativeTheme = {
  themeSource: 'system',
  shouldUseDarkColors: false,
};

export const shell = {
  openExternal: async () => {},
};

export const contextBridge = {
  exposeInMainWorld: () => {},
};

export const ipcRenderer = {
  invoke: async () => undefined,
  on: () => {},
  removeListener: () => {},
};

export default {
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  nativeTheme,
  shell,
  contextBridge,
  ipcRenderer,
};
