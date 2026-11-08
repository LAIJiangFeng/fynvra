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
  app.getAppPath = () => runtimeRoot;
  Object.defineProperty(app, 'isPackaged', { get: () => true });
  // 强制打包态会让主进程设置已安装版的任务栏身份；改用测试专用 id，避免污染已安装的 Fynvra。
  const E2E_APP_ID = 'com.fynvra.app.e2e';
  let requestedAppId = null;
  let appliedAppId = null;
  const setAppId = app.setAppUserModelId.bind(app);
  app.setAppUserModelId = (id) => {
    requestedAppId = id;
    appliedAppId = E2E_APP_ID;
    setAppId(E2E_APP_ID);
  };
  const appId = () => ({ requested: requestedAppId, applied: appliedAppId });
  const packageInfo = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'));
  const manualMac = mac && packageInfo.fynvraMacUpdateMode !== 'signed';
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
  // 产品走应用内对话框（showAppMessageBox）；Renderer 未及时确认时回退原生对话框。
  // 原生 stub 作为兜底应答，避免真实模态框卡住 CI，并记录实际走的路径。
  const UNSAVED_TITLE = '文件修改尚未保存';
  const INSTALL_TITLE = '安装 Fynvra 更新';
  const dialogPaths = new Set();
  const nativeCalls = { install: 0, file: 0 };
  const answerNative = (args) => {
    const options = args.at(-1) ?? {};
    dialogPaths.add('native');
    if (options.title === UNSAVED_TITLE) {
      nativeCalls.file += 1;
      fileConfirmations += 1;
      return discardChoice;
    }
    nativeCalls.install += 1;
    return installChoice;
  };
  dialog.showMessageBox = async (...args) => ({
    response: answerNative(args),
    checkboxChecked: false,
  });
  dialog.showMessageBoxSync = (...args) => answerNative(args);
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
      if (process.platform === 'win32') {
        assert.equal(requestedAppId, 'com.fynvra.app', '打包分支请求的应用身份已被拦截');
        checks.push('Windows 应用身份使用测试专用 id，不影响已安装的 Fynvra');
      }
      checks.push('明确放弃未保存文件后，等待 agent 退出才调用安装器');
      checks.push(`确认对话框实际路径: ${[...dialogPaths].join(' + ') || '无'}`);
      assert.equal(readFileSync(join(base, 'workspace/notes.txt'), 'utf8'), '原始文件\n');
      writeFileSync(
        join(base, 'report.json'),
        JSON.stringify(
          {
            ok: true,
            platform: process.platform,
            arch: process.arch,
            runtimeRoot,
            appId: appId(),
            checks,
            dialogPaths: [...dialogPaths],
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
      // 应用内确认框：只在包含 title 的 alertdialog 内按文字点按钮（设置页也有同名按钮）。
      // 若 Renderer 未接手而回退原生，stub 已按 installChoice / discardChoice 应答。
      const answerDialog = async (title, buttonText, kind, { waitClose = true } = {}) => {
        const before = nativeCalls[kind];
        const dialogExpr = `[...document.querySelectorAll('[role="alertdialog"]')].find(e => !e.hasAttribute('data-closed') && e.textContent.includes(${JSON.stringify(title)}))`;
        const buttonExpr = `[...(${dialogExpr})?.querySelectorAll('button') ?? []].find(e => e.textContent.trim() === ${JSON.stringify(buttonText)})`;
        const start = Date.now();
        while (Date.now() - start < 30000) {
          if (nativeCalls[kind] > before) return 'native';
          if (await evaluate(`!!(${buttonExpr})`)) {
            dialogPaths.add('in-app');
            if (kind === 'file') fileConfirmations += 1;
            await evaluate(`(${buttonExpr}).click()`);
            if (waitClose) await waitFor(`!(${dialogExpr})`, `${title} 关闭`);
            return 'in-app';
          }
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        throw new Error(`等待失败: ${title} 对话框`);
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
        if (manualMac) {
          await waitFor(stateIs('disabled'), '手动 Mac 安装包不启用自动更新');
          const result = await evaluate('window.fynvra.updates.check()');
          assert.equal(result.state.reason, 'manual-install');
          await waitFor(`document.body.innerText.includes('手动安装')`, '手动安装说明可见');
          await new Promise((resolve) => setTimeout(resolve, 11_000));
          assert.equal(requests.length, 0, '手动包不能后台请求原生更新');
          assert.equal(installCalls, 0);
          checks.push(
            '打包后的 Mac 手动版可启动，设置明确提示手动安装，自动与手动检查均不请求更新源'
          );
          app.once('will-quit', () => {
            try {
              assert.equal(BrowserWindow.getAllWindows().length, 0);
              assert.equal(activeWorkers.size, 0);
              assert.equal(errors.length, 0, errors.join('\n'));
              checks.push('正常退出等待窗口和 agent 收尾');
              writeFileSync(
                join(base, 'report.json'),
                JSON.stringify(
                  {
                    ok: true,
                    platform: process.platform,
                    arch: process.arch,
                    runtimeRoot,
                    mode: 'manual',
                    appId: appId(),
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
            } catch (error) {
              fail(error);
            }
          });
          app.quit();
          return;
        }
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
        // 原 installChoice = 1：取消
        await answerDialog(INSTALL_TITLE, '取消', 'install');
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
        await answerDialog(INSTALL_TITLE, '重启并安装', 'install');
        // 原 discardChoice = 0：取消（按钮顺序：取消 / 保留草稿并离开 / 放弃修改并离开）
        await answerDialog(UNSAVED_TITLE, '取消', 'file');
        await waitFor(stateIs('downloaded'), '取消文件退出回到待安装');
        assert(fileConfirmations > 0);
        assert.equal(installCalls, 0);
        assert(activeWorkers.size > 0, '取消退出保留 agent 进程');
        assert((await evaluate('window.fynvra.roles.list()')).ok);
        checks.push('未保存文件确认取消后保留草稿、agent 和待安装状态');
        await capture('updates-canceled.png');
        discardChoice = 1;
        await clickText('重启并安装');
        await answerDialog(INSTALL_TITLE, '重启并安装', 'install');
        // 原 discardChoice = 1：保留草稿并离开；之后窗口关闭，不再等待对话框收起
        await answerDialog(UNSAVED_TITLE, '保留草稿并离开', 'file', { waitClose: false });
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
