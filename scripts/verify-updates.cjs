const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const project = resolve(__dirname, '..');
const runtimeRoot = process.env.FYNVRA_TEST_APP_ROOT || project;
const localRequire = createRequire(join(project, 'package.json'));
const mac = process.platform === 'darwin';

if (!process.versions.electron) {
  if (process.platform !== 'win32' && !mac) throw new Error('此联调脚本只验证 Windows 和 Mac 更新');
  const base = mkdtempSync(join(tmpdir(), 'fynvra-updates-e2e-'));
  for (const directory of ['user-data', 'workspace', 'cache']) mkdirSync(join(base, directory));
  writeFileSync(join(base, 'workspace/notes.txt'), '原始文件\n');
  writeFileSync(
    join(base, 'user-data/settings.json'),
    JSON.stringify({
      version: 1,
      preferences: { theme: 'dark', language: 'zh-CN', sidePanelOpen: true },
      workspaces: [
        { id: 'update-test', name: '更新验证', repoPath: join(base, 'workspace'), vcs: 'none' },
      ],
    })
  );
  const env = { ...process.env, FYNVRA_TEST_BASE: base, LOCALAPPDATA: join(base, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = require('node:child_process').spawn(localRequire('electron'), [__filename], {
    cwd: project,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    if (code !== 0) process.exit(code ?? 1);
    const report = JSON.parse(readFileSync(join(base, 'report.json'), 'utf8'));
    assert(report.ok);
    console.log('更新联调报告:', join(base, 'report.json'));
    console.log(JSON.stringify(report, null, 2));
  });
} else {
  const {
    app,
    dialog,
    utilityProcess,
    BrowserWindow,
    autoUpdater: nativeUpdater,
  } = require('electron');
  const base = process.env.FYNVRA_TEST_BASE;
  app.setPath('userData', join(base, 'user-data'));
  app.getVersion = () => '0.1.0';
  Object.defineProperty(app, 'isPackaged', { get: () => true });
  const { autoUpdater } = createRequire(join(runtimeRoot, 'package.json'))('electron-updater');
  autoUpdater.disableDifferentialDownload = true;
  Object.defineProperty(autoUpdater.app, 'baseCachePath', { get: () => join(base, 'cache') });
  if (mac) {
    // 测试文件不是真实签名包；保留 HTTP 下载和校验，但禁止交给原生 Squirrel 安装。
    nativeUpdater.setFeedURL = () => {};
    nativeUpdater.checkForUpdates = () => assert.fail('测试不得触发原生安装');
  }
  let failMetadata = true;
  let installChoice = 1;
  let discardChoice = 0;
  let installCalls = 0;
  let fileConfirmations = 0;
  const activeWorkers = new Set();
  const fork = utilityProcess.fork.bind(utilityProcess);
  utilityProcess.fork = (...args) => {
    const child = fork(...args);
    activeWorkers.add(child);
    child.once('exit', () => activeWorkers.delete(child));
    return child;
  };
  dialog.showMessageBox = async () => ({ response: installChoice, checkboxChecked: false });
  dialog.showMessageBoxSync = () => {
    fileConfirmations += 1;
    return discardChoice;
  };
  const checks = [];
  const requests = [];
  const errors = [];
  const installer = Buffer.alloc(4 * 1024 * 1024, 42);
  const filename = mac ? `Fynvra-0.1.1-mac-${process.arch}.zip` : 'Fynvra-0.1.1-x64-setup.exe';
  const metadataPath = mac ? '/latest-mac.yml' : '/latest.yml';
  const sha512 = createHash('sha512').update(installer).digest('base64');
  const metadata = JSON.stringify({
    version: '0.1.1',
    path: filename,
    sha512,
    files: [{ url: filename, size: installer.length, sha512 }],
    releaseDate: new Date().toISOString(),
  });
  const server = require('node:http').createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push(path);
    if (path === metadataPath) {
      response.writeHead(failMetadata ? 503 : 200, { 'Content-Type': 'text/yaml' });
      response.end(failMetadata ? 'temporary failure' : metadata);
      return;
    }
    if (path !== `/${filename}`) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': installer.length,
      'Content-Type': 'application/octet-stream',
    });
    let offset = 0;
    const timer = setInterval(() => {
      const end = Math.min(offset + 64 * 1024, installer.length);
      response.write(installer.subarray(offset, end));
      offset = end;
      if (offset === installer.length) {
        clearInterval(timer);
        response.end();
      }
    }, 30);
    response.on('close', () => clearInterval(timer));
  });
  const deadline = setTimeout(() => {
    console.error('更新联调超时');
    app.exit(1);
  }, 120000);
  const fail = (error) => {
    console.error(error);
    clearTimeout(deadline);
    server.close();
    app.exit(1);
  };

  // 只替换最终安装动作：真实 updater 负责 HTTP、哈希校验、缓存和下载事件，测试文件永不执行。
  autoUpdater.quitAndInstall = () => {
    try {
      installCalls += 1;
      assert.equal(BrowserWindow.getAllWindows().length, 0, '安装前全部窗口已确认关闭');
      assert.equal(activeWorkers.size, 0, '安装前 agent 已实际退出');
      assert.equal(installCalls, 1);
      assert.equal(errors.length, 0, errors.join('\n'));
      checks.push('明确放弃未保存文件后，等待 agent 退出才调用安装器');
      assert.equal(readFileSync(join(base, 'workspace/notes.txt'), 'utf8'), '原始文件\n');
      writeFileSync(
        join(base, 'report.json'),
        JSON.stringify(
          {
            ok: true,
            platform: process.platform,
            arch: process.arch,
            runtimeRoot,
            checks,
            requests,
            installCalls,
            rendererErrors: errors,
          },
          null,
          2
        )
      );
      clearTimeout(deadline);
      server.close();
      app.quit();
    } catch (error) {
      fail(error);
    }
  };

  app.on('browser-window-created', (_event, window) => {
    window.show = () => {};
    window.setSize(1280, 800);
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    window.webContents.once('did-finish-load', async () => {
      const evaluate = (source) => window.webContents.executeJavaScript(source);
      const waitFor = async (condition, label) => {
        const start = Date.now();
        while (Date.now() - start < 30000) {
          if (await evaluate(condition)) return;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        throw new Error(`等待失败: ${label}`);
      };
      const click = async (selector) => {
        await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      };
      const clickText = async (text, selector = 'button') => {
        const expression = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getBoundingClientRect().height > 0 && e.textContent.trim() === ${JSON.stringify(text)})`;
        await waitFor(`!!(${expression})`, text);
        await evaluate(`(${expression}).click()`);
      };
      const stateIs = (status) =>
        `window.fynvra.updates.state().then(result => result.ok && result.state.status === ${JSON.stringify(status)})`;
      const capture = async (name) => {
        const [width, height] = window.getSize();
        window.setSize(width + 1, height);
        window.setSize(width, height);
        await evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
        );
        writeFileSync(join(base, name), (await window.webContents.capturePage()).toPNG());
      };
      try {
        await click('button[aria-label="设置"]');
        await clickText('通用', '[role="tab"]');
        await waitFor(`document.body.innerText.includes('当前版本 0.1.0')`, '当前版本');
        await waitFor(stateIs('error'), '自动检查返回服务端故障');
        assert(requests.includes(metadataPath));
        await waitFor(`document.body.innerText.includes('更新失败，请重试')`, '错误可见');
        checks.push('启动后自动请求更新，网络错误可见且不误报最新版');
        failMetadata = false;
        await clickText('检查更新');
        await waitFor(stateIs('downloading'), '实际 HTTP 下载');
        await waitFor(
          `!!document.querySelector('progress[aria-label="更新下载进度"]')`,
          '下载进度可见'
        );
        await capture('updates-downloading.png');
        await waitFor(stateIs('downloaded'), '真实 updater 校验并缓存文件');
        const status = await evaluate('window.fynvra.updates.state()');
        assert.equal(status.state.version, '0.1.1');
        assert(requests.includes(`/${filename}`));
        assert.equal(
          autoUpdater.downloadedUpdateHelper.cacheDir,
          join(base, 'cache', 'fynvra-test-updater')
        );
        assert.equal(installCalls, 0);
        checks.push('真实 HTTP 下载、哈希校验和缓存成功，界面显示安装按钮但不主动退出');
        await capture('updates-ready.png');
        await clickText('重启并安装');
        await waitFor(stateIs('downloaded'), '取消安装确认保留应用');
        assert.equal(installCalls, 0);
        checks.push('取消安装确认不启动安装器');
        await click('button[aria-label="关闭设置"]');
        await waitFor(
          `document.querySelector('section[aria-label="应用更新"]')?.innerText.includes('0.1.1')`,
          '全局提醒'
        );
        const workspace = `[...document.querySelectorAll('aside button')].find(e => e.textContent.includes('更新验证'))`;
        await waitFor(`!!(${workspace})`, '测试工作区');
        await evaluate(`(${workspace}).click()`);
        await click('nav[aria-label="文件目录"] button[title="notes.txt"]');
        await waitFor(`!!document.querySelector('.cm-content')`, '文件编辑器');
        await evaluate(`document.querySelector('.cm-content').focus()`);
        await window.webContents.insertText('尚未保存的更新验证草稿');
        await waitFor(`document.body.innerText.includes('未保存')`, '文件草稿');
        installChoice = 0;
        await clickText('重启并安装');
        await waitFor(stateIs('downloaded'), '取消文件退出回到待安装');
        assert(fileConfirmations > 0);
        assert.equal(installCalls, 0);
        assert(activeWorkers.size > 0, '取消退出保留 agent 进程');
        assert((await evaluate('window.fynvra.roles.list()')).ok);
        checks.push('未保存文件确认取消后保留草稿、agent 和待安装状态');
        await capture('updates-canceled.png');
        discardChoice = 1;
        await clickText('重启并安装');
      } catch (error) {
        if (!window.isDestroyed()) {
          console.error(await evaluate('document.body.innerText'));
          await capture('updates-failure.png');
        }
        fail(error);
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const config = join(base, 'app-update.yml');
    writeFileSync(
      config,
      JSON.stringify({
        provider: 'generic',
        url: `http://127.0.0.1:${server.address().port}`,
        updaterCacheDirName: 'fynvra-test-updater',
      })
    );
    autoUpdater.updateConfigPath = config;
    import(pathToFileURL(join(runtimeRoot, 'out/main/index.js')).href).catch(fail);
  });
}
