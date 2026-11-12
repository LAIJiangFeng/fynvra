// electron-builder afterPack（签名之前运行）：macOS 上 node-pty 经 spawn-helper 起 shell，
// 打包后它若丢了执行位，每个终端都只会报 "posix_spawnp failed."。
const { chmodSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const helperPattern = /(?:^|\/)app\.asar\.unpacked\/node_modules\/node-pty\/.*\/spawn-helper$/;

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'darwin' && platform !== 'linux') return;
  const helpers = readdirSync(context.appOutDir, { recursive: true })
    .map((path) => String(path).replaceAll('\\', '/'))
    .filter((path) => helperPattern.test(path))
    .map((path) => join(context.appOutDir, path));
  if (platform === 'darwin' && helpers.length === 0)
    throw new Error(`afterPack: node-pty spawn-helper not found under ${context.appOutDir}`);
  for (const helper of helpers) chmodSync(helper, 0o755);
};
