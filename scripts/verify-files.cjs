// pnpm build && node scripts/verify-files.cjs
// 隔离 userData 和临时工作区，走真实 Renderer / preload / Main；回收站只处理测试文件。
const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');

const project = resolve(__dirname, '..');
if (!process.versions.electron) {
  const base = mkdtempSync(join(tmpdir(), 'fynvra-files-e2e-'));
  const workspace = join(base, 'workspace');
  const userData = join(base, 'user-data');
  mkdirSync(userData);
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'existing.txt'), '不要覆盖');
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      preferences: { theme: 'dark', language: 'zh-CN', sidePanelOpen: true },
      workspaces: [{ id: 'files-test', name: '文件操作验证', repoPath: workspace, vcs: 'none' }],
    })
  );
  const env = { ...process.env, FYNVRA_USER_DATA_DIR: userData, FYNVRA_FILES_TEST_BASE: base };
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
    console.log('文件联调证据:', base);
    if (code === 0) console.log(readFileSync(join(base, 'report.json'), 'utf8'));
  });
} else {
  const { app, ipcMain, shell } = require('electron');
  const base = process.env.FYNVRA_FILES_TEST_BASE;
  const workspace = join(base, 'workspace');
  const checks = [];
  const errors = [];
  const revealed = [];
  const creations = [];
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      if (channel === 'files:create') creations.push(args[0]);
      return listener(event, ...args);
    });
  let rejectReveal = false;
  let rejectTrash = false;
  // 不弹出系统资源管理器；验证它确实收到 Main 校验过的路径。
  shell.showItemInFolder = (path) => {
    if (rejectReveal) throw new Error('模拟系统失败');
    revealed.push(path);
  };
  const trashItem = shell.trashItem.bind(shell);
  shell.trashItem = async (path) => {
    assert(path.startsWith(workspace + sep), '只能回收测试工作区中的条目');
    if (rejectTrash) throw new Error('模拟回收站失败');
    await trashItem(path);
  };
  const fail = (error) => {
    console.error(error);
    app.exit(1);
  };
  const deadline = setTimeout(() => fail(new Error('文件联调超时')), 90000);
  app.getAppPath = () => project;
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {};
    const wc = window.webContents;
    wc.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    wc.once('did-finish-load', async () => {
      const evaluate = (source) => wc.executeJavaScript(source);
      const waitFor = async (condition, label) => {
        const start = Date.now();
        while (Date.now() - start < 10000) {
          if (await (typeof condition === 'function' ? condition() : evaluate(condition))) return;
          await new Promise((done) => setTimeout(done, 50));
        }
        throw new Error(`等待失败: ${label}`);
      };
      const element = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
      const textButton = (text, scope = 'button') =>
        `[...document.querySelectorAll(${JSON.stringify(scope)})].find(e => e.getBoundingClientRect().height > 0 && e.textContent.trim() === ${JSON.stringify(text)})`;
      const clickText = async (text, scope) => {
        const target = textButton(text, scope);
        await waitFor(`!!(${target})`, text);
        await evaluate(`(${target}).click()`);
      };
      const tree = 'nav[aria-label="文件目录"]';
      const row = (path) => `${tree} button[title="${path}"]`;
      const input = `${tree} input`;
      const context = async (selector) => {
        await waitFor(`!!${element(selector)}`, selector);
        await evaluate(
          `${element(selector)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1100, clientY: 150 }))`
        );
        await waitFor('!!document.querySelector("[role=menu]")', '右键菜单');
      };
      const beginCreate = async (selector, folder = false) => {
        await context(selector);
        await clickText(folder ? '新建文件夹' : '新建文件', '[role=menuitem]');
        await waitFor(`document.activeElement === ${element(input)}`, '行内输入获得焦点');
        assert.equal(await evaluate('!!document.querySelector("[role=dialog]")'), false);
        assert.equal(await evaluate('!!document.querySelector("[role=menu]")'), false);
      };
      const typeName = async (name) => {
        await evaluate(
          `${element(input)}.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(${element(input)}, ${JSON.stringify(name)}); ${element(input)}.dispatchEvent(new Event('input', { bubbles: true }))`
        );
        await waitFor(`${element(input)}?.value === ${JSON.stringify(name)}`, name);
      };
      const key = (keyCode) => {
        wc.sendInputEvent({ type: 'keyDown', keyCode });
        wc.sendInputEvent({ type: 'keyUp', keyCode });
      };
      const submit = async (path) => {
        key('Enter');
        await waitFor(`!${element(input)} && !!${element(row(path))}`, path);
      };
      const clickOutside = async () => {
        const position = await evaluate(`(() => {
          const rect = ${element(tree)}.getBoundingClientRect();
          return { x: Math.round(rect.left + 20), y: Math.round(rect.bottom - 20) };
        })()`);
        // 隐藏窗口通过 CDP 派发鼠标事件，确保触发真实的焦点变化。
        if (!wc.debugger.isAttached()) wc.debugger.attach();
        for (const type of ['mousePressed', 'mouseReleased']) {
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type,
            button: 'left',
            clickCount: 1,
            ...position,
          });
        }
      };
      const capture = async (name) => {
        const [width, height] = window.getSize();
        window.setSize(width + 1, height);
        window.setSize(width, height);
        await evaluate(
          'new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))'
        );
        writeFileSync(join(base, name), (await wc.capturePage()).toPNG());
      };
      try {
        assert.equal(app.getPath('userData'), process.env.FYNVRA_USER_DATA_DIR);
        const workspaceButton = `[...document.querySelectorAll('aside button')].find(e => e.textContent.includes('文件操作验证'))`;
        await waitFor(`!!(${workspaceButton})`, '测试工作区');
        await evaluate(`(${workspaceButton}).click()`);
        const initialEntries = readdirSync(workspace);
        for (const [folder, name] of [
          [false, ''],
          [true, '   '],
        ]) {
          await beginCreate(tree, folder);
          await typeName(name);
          await clickOutside();
          await waitFor(`!${element(input)}`, '空名称失焦自动取消');
        }
        assert.equal(creations.length, 0, '空名称取消不能发创建请求');
        assert.deepEqual(readdirSync(workspace), initialEntries);
        checks.push('未输入名称或只有空格时，鼠标点击空白处自动取消，不写磁盘');

        await beginCreate(row('src'));
        assert.equal(
          await evaluate(`${element(row('src'))}.getAttribute('aria-expanded')`),
          'true'
        );
        assert(
          await evaluate(
            `${element(row('src'))}.parentElement.querySelector('ul > li:first-child input') === ${element(input)}`
          )
        );
        await typeName('existing.txt');
        await clickOutside();
        await waitFor(`${element(input)}?.getAttribute('aria-invalid') === 'true'`, '重名提示');
        assert.equal(readFileSync(join(workspace, 'src', 'existing.txt'), 'utf8'), '不要覆盖');
        assert.equal(await evaluate(`${element(input)}.value`), 'existing.txt');
        await typeName('新建 文件.txt');
        await capture('inline-new-file.png');
        await clickOutside();
        await waitFor(
          `!${element(input)} && !!${element(row('src/新建 文件.txt'))}`,
          '失焦创建文件'
        );
        assert.equal(readFileSync(join(workspace, 'src', '新建 文件.txt'), 'utf8'), '');
        checks.push('失焦自动创建文件；重名保留输入且不覆盖，修改后再次点击别处创建成功');

        await beginCreate(tree, true);
        await typeName('新建目录');
        await clickOutside();
        await waitFor(`!${element(input)} && !!${element(row('新建目录'))}`, '失焦创建文件夹');
        await waitFor(
          `${element(row('新建目录'))}.parentElement.textContent.includes('空目录')`,
          '新建目录完成加载'
        );
        await beginCreate(row('新建目录'));
        await typeName('取消.txt');
        const beforeCancel = creations.length;
        key('Escape');
        await waitFor(`!${element(input)}`, '取消输入');
        await clickOutside();
        assert.equal(creations.length, beforeCancel, 'Esc 不能因失焦而创建');
        assert(!existsSync(join(workspace, '新建目录', '取消.txt')));
        checks.push('根目录失焦创建文件夹后展开并完成加载，Esc 取消不写磁盘');

        await context(tree);
        key('Down');
        await waitFor('document.activeElement?.textContent === "新建文件"', '方向键选择菜单');
        key('Enter');
        await waitFor(`document.activeElement === ${element(input)}`, '键盘新建后输入获得焦点');
        assert.equal(await evaluate('!!document.querySelector("[role=menu]")'), false);
        assert.equal(await evaluate('!!document.querySelector("[role=dialog]")'), false);
        await typeName('root.txt');
        await evaluate(
          `${element(input)}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))`
        );
        assert(!existsSync(join(workspace, 'root.txt')), '中文输入法选词不能提前创建');
        const submitting = submit('root.txt');
        await clickOutside();
        await submitting;
        assert.equal(creations.filter((request) => request.name === 'root.txt').length, 1);
        checks.push('Enter 与鼠标失焦只创建一次，中文输入法选词 Enter 不提前提交');

        await context(row('root.txt'));
        assert(
          await evaluate(
            `!!(${textButton('在文件资源管理器中显示', '[role=menuitem]')}).querySelector('svg')`
          )
        );
        await clickText('在文件资源管理器中显示', '[role=menuitem]');
        await waitFor('!document.querySelector("[role=menu]")', '菜单关闭');
        await waitFor(() => revealed.length === 1, 'Main 调用系统显示位置');
        assert.deepEqual(revealed, [join(workspace, 'root.txt')]);
        rejectReveal = true;
        await context(row('root.txt'));
        await clickText('在文件资源管理器中显示', '[role=menuitem]');
        await waitFor(
          'document.body.innerText.includes("文件操作失败，请检查权限后重试")',
          '显示位置失败可见'
        );
        rejectReveal = false;
        checks.push('显示位置有图标，调用原生 shell 接口时路径正确，失败有提示');

        await context(row('root.txt'));
        await clickText('删除', '[role=menuitem]');
        await clickText('取消', '[role=dialog] button');
        assert(existsSync(join(workspace, 'root.txt')));
        await context(row('root.txt'));
        await clickText('删除', '[role=menuitem]');
        rejectTrash = true;
        await clickText('删除', '[role=dialog] button');
        await waitFor(
          'document.querySelector("[role=dialog] [role=alert]")?.textContent.includes("文件操作失败")',
          '回收站失败'
        );
        assert(existsSync(join(workspace, 'root.txt')));
        rejectTrash = false;
        await clickText('删除', '[role=dialog] button');
        await waitFor(
          `!document.querySelector('[role=dialog]') && !${element(row('root.txt'))}`,
          '删除后刷新'
        );
        assert(!existsSync(join(workspace, 'root.txt')));
        checks.push('取消删除保留文件，回收站失败可重试，确认后真实移入系统回收站并刷新目录');

        await context(row('src'));
        await clickText('删除', '[role=menuitem]');
        await clickText('删除', '[role=dialog] button');
        await waitFor(
          `!document.querySelector('[role=dialog]') && !${element(row('src'))}`,
          '删除目录'
        );
        assert(!existsSync(join(workspace, 'src')));
        assert.equal(
          await evaluate('!!document.querySelector("[aria-label=\\"关闭 新建 文件.txt\\"]")'),
          false
        );
        checks.push('非空目录移入系统回收站，并关闭其子文件标签');
        assert.equal(errors.length, 0, errors.join('\n'));
        writeFileSync(
          join(base, 'report.json'),
          JSON.stringify({ ok: true, checks, errors }, null, 2)
        );
        clearTimeout(deadline);
        app.quit();
      } catch (error) {
        console.error(await evaluate('document.body.innerText'));
        await capture('failure.png');
        fail(error);
      }
    });
  });
  import(pathToFileURL(join(project, 'out/main/index.js')).href).catch(fail);
}
