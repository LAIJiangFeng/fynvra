// pnpm build && node scripts/verify-window.cjs
// 隔离数据，真实窗口 / 托盘 / worker / IPC，仅代答原生确认框，不操作用户的工作区。
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const project = resolve(__dirname, '..');

if (!process.versions.electron) {
  const base = mkdtempSync(join(tmpdir(), 'fynvra-window-e2e-'));
  const userData = join(base, 'user-data');
  const workspace = join(base, 'workspace');
  mkdirSync(userData);
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'notes.txt'), '磁盘原文');
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      preferences: { language: 'zh-CN', sidePanelOpen: true },
      workspaces: [{ id: 'window-test', name: '窗口验证', repoPath: workspace, vcs: 'none' }],
    })
  );
  const env = { ...process.env, FYNVRA_WINDOW_TEST_BASE: base, FYNVRA_USER_DATA_DIR: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
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
    process.exitCode = code ?? 1;
    console.log('窗口联调证据:', base);
    if (code === 0) console.log(readFileSync(join(base, 'report.json'), 'utf8'));
  });
} else {
  const { app, dialog, nativeImage, Tray, utilityProcess } = require('electron');
  const base = process.env.FYNVRA_WINDOW_TEST_BASE;
  const checks = [];
  const errors = [];
  const workers = new Set();
  const icons = [];
  let appId;
  let tray;
  let trayMenu;
  let closeResponse = 0;
  let discardResponse = 0;
  let closePrompts = 0;
  let discardPrompts = 0;
  app.getAppPath = () => project;
  const setAppId = app.setAppUserModelId.bind(app);
  app.setAppUserModelId = (id) => {
    appId = id;
    setAppId(id);
  };
  const loadImage = nativeImage.createFromPath.bind(nativeImage);
  nativeImage.createFromPath = (path) => {
    const image = loadImage(path);
    icons.push({ path, empty: image.isEmpty() });
    return image;
  };
  const setMenu = Tray.prototype.setContextMenu;
  Tray.prototype.setContextMenu = function (menu) {
    tray = this;
    trayMenu = menu;
    return setMenu.call(this, menu);
  };
  const fork = utilityProcess.fork.bind(utilityProcess);
  utilityProcess.fork = (...args) => {
    const child = fork(...args);
    workers.add(child);
    child.once('exit', () => workers.delete(child));
    return child;
  };
  dialog.showMessageBox = async (_window, options) => {
    assert.deepEqual(options.buttons, ['取消', '最小化到托盘', '退出']);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    closePrompts += 1;
    return { response: closeResponse, checkboxChecked: false };
  };
  dialog.showMessageBoxSync = (_window, options) => {
    assert.equal(options.title, '文件修改尚未保存');
    discardPrompts += 1;
    return discardResponse;
  };
  const fail = (error) => {
    console.error(error);
    app.exit(1);
  };
  dialog.showErrorBox = (title, message) => fail(new Error(`${title}: ${message}`));
  const deadline = setTimeout(() => fail(new Error('窗口联调超时')), 90000);
  app.on('browser-window-created', (_event, win) => {
    let shown = 0;
    let hidden = 0;
    // 不打断用户当前窗口；保留真实 hide / close / unload 和系统托盘。
    win.show = () => {
      shown += 1;
    };
    const hide = win.hide.bind(win);
    win.hide = () => {
      hidden += 1;
      hide();
    };
    const wc = win.webContents;
    wc.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    wc.once('did-finish-load', async () => {
      const evaluate = (source) => wc.executeJavaScript(source);
      const waitFor = async (condition, label) => {
        const start = Date.now();
        while (Date.now() - start < 10000) {
          if (await (typeof condition === 'function' ? condition() : evaluate(condition))) return;
          await new Promise((done) => setTimeout(done, 30));
        }
        throw new Error(`等待失败: ${label}`);
      };
      const click = async (selector) => {
        const expression = `document.querySelector(${JSON.stringify(selector)})`;
        await waitFor(`!!${expression}`, selector);
        await evaluate(`${expression}.click()`);
      };
      const close = () => evaluate('window.fynvra.window.close()');
      const draftExists = () =>
        evaluate('document.querySelector(".cm-content")?.textContent.includes("未保存草稿")');
      try {
        if (process.platform === 'win32') assert.equal(appId, 'com.fynvra.app.dev');
        const workspace = `[...document.querySelectorAll('aside button')].find(e => e.textContent.includes('窗口验证'))`;
        await waitFor(`!!(${workspace})`, '测试工作区');
        await evaluate(`(${workspace}).click()`);
        await click('nav[aria-label="文件目录"] button[title="notes.txt"]');
        await waitFor('!!document.querySelector(".cm-content")', '文件编辑器');
        await evaluate('document.querySelector(".cm-content").focus()');
        await wc.insertText('未保存草稿');
        await waitFor(draftExists, '文件草稿');
        await close();
        await waitFor(() => closePrompts === 1, '关闭确认');
        assert.equal(hidden, 0);
        assert(!win.isDestroyed());
        assert(workers.size > 0);
        assert(await draftExists());
        checks.push('标题栏关闭经真实 IPC 询问三种选择，默认取消，保留草稿和 worker');

        closeResponse = 1;
        await close();
        await waitFor(() => hidden === 1, '隐藏到托盘');
        assert(tray && !tray.isDestroyed());
        assert.equal(discardPrompts, 0);
        assert(workers.size > 0);
        const icon = icons.find((item) => item.path.startsWith(join(project, 'out') + sep));
        assert(icon && !icon.empty, '图标必须从构建产物加载，不能依赖源码目录');
        assert(readFileSync(icon.path).equals(readFileSync(join(project, 'resources/icon.png'))));
        assert.deepEqual(
          trayMenu.items.filter((item) => item.type !== 'separator').map((item) => item.label),
          ['显示 Fynvra', '退出']
        );
        const beforeTray = shown;
        tray.emit('click');
        assert(shown > beforeTray);
        assert(await draftExists());
        checks.push('真实托盘创建成功，使用随包 Fynvra 图标；点击恢复，草稿和 worker 保留');

        for (const event of ['second-instance', 'activate']) {
          const beforeHide = hidden;
          await close();
          await waitFor(() => hidden > beforeHide, '再次隐藏');
          const beforeShow = shown;
          app.emit(event);
          assert(shown > beforeShow, `${event} 应显示隐藏窗口`);
        }
        checks.push('重复隐藏复用托盘，单实例唤醒及应用激活均能恢复隐藏窗口');

        closeResponse = 2;
        win.close();
        await waitFor(() => discardPrompts === 1, '退出前确认未保存文件');
        assert(!win.isDestroyed());
        assert(workers.size > 0);
        assert(await draftExists());
        closeResponse = 0;
        const beforeRetry = closePrompts;
        await close();
        await waitFor(() => closePrompts > beforeRetry, '取消退出后仍可询问');
        checks.push('系统关窗选择退出后仍保护未保存文件，取消后继续可用且下次关窗仍询问');

        const beforeQuit = closePrompts;
        discardResponse = 1;
        app.once('will-quit', () => {
          try {
            assert(win.isDestroyed());
            assert(tray.isDestroyed());
            assert.equal(workers.size, 0);
            assert.equal(closePrompts, beforeQuit, '明确退出不能再弹托盘选择');
            assert.equal(readFileSync(join(base, 'workspace/notes.txt'), 'utf8'), '磁盘原文');
            assert.deepEqual(errors, []);
            checks.push('托盘退出先确认放弃草稿，再实际关闭 worker 和托盘，不额外弹关窗选择');
            writeFileSync(
              join(base, 'report.json'),
              JSON.stringify({ ok: true, checks, errors, icons, appId }, null, 2)
            );
            clearTimeout(deadline);
          } catch (error) {
            fail(error);
          }
        });
        trayMenu.items.find((item) => item.label === '退出').click();
      } catch (error) {
        fail(error);
      }
    });
  });
  import(pathToFileURL(join(project, 'out/main/index.js')).href).catch(fail);
}
