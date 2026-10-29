// 首页与文档共用的产品流程演示控制器（任务协作 / 指定 Worker 模型 / 输入排队 / 角色对话）。
// 每个 [data-demo] 容器互相隔离：只注册容器里真实存在的场景，各自持有计时器与可见性状态；
// 只有一个场景时原地重播，有多个场景（首页）时按 next 轮播。只操作 data-* 和 class，
// 语言跟随 <html data-locale>。
(() => {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const TYPE_INTERVAL = 20;
  // 打完最后一个字符后短暂停留即可提交，不再白等固定 2 秒起。
  const TYPE_SETTLE = 300;
  const END_HOLD = 1200;

  const collabText = {
    zh: '优化官网首页：标题收紧一点，把顶部演示改成真实操作流程；文档页交给另一个 Worker。',
    en: 'Polish the homepage: smaller title, a real workflow demo. Give the docs page to another worker.',
  };
  const modelText = {
    zh: '让实现侧栏折叠的 Worker 用 DeepSeek，审查改动的 Worker 用 GPT。',
    en: 'Use DeepSeek for the worker implementing sidebar collapse, and GPT for the worker reviewing the diff.',
  };
  // 排队场景连续输入两次，每次提交后输入框清空，当前回合结束后按顺序接续。
  const queueText = {
    first: {
      zh: '补上移动端适配。',
      en: 'Add the mobile layout.',
    },
    second: {
      zh: '再补一份使用说明。',
      en: 'Then add a short usage guide.',
    },
  };
  // 角色场景在两个独立会话里分别向 Worker 和自定义审查员直接提需求。
  const roleText = {
    worker: {
      zh: '为设置页增加侧栏折叠。',
      en: 'Add sidebar collapse to the settings page.',
    },
    review: {
      zh: '检查当前改动，只列问题与建议，不修改文件。',
      en: 'Review the current diff. List issues and suggestions only — do not edit files.',
    },
  };

  const locale = () => (document.documentElement.dataset.locale === 'en' ? 'en' : 'zh');

  // 每个演示容器注册自己的同步 / 重播入口，全局事件统一派发。
  const instances = [];

  function renderCollabScene(element, phase) {
    const taskHome = element.querySelector('[data-task="home"]');
    const taskDocs = element.querySelector('[data-task="docs"]');
    const taskCount = element.querySelector('[data-task-count]');
    const run = element.querySelector('[data-run]');
    const panelFiles = element.querySelector('[data-panel-view="files"]');
    const panelTasks = element.querySelector('[data-panel-view="tasks"]');
    const panelTabs = [...element.querySelectorAll('[data-panel-tab]')];
    const sessionHome = element.querySelector('[data-session="home"]');
    const sessionDocs = element.querySelector('[data-session="docs"]');
    const sessionOrchestrator = element.querySelector('[data-session="orchestrator"]');
    const chatHead = element.querySelector('[data-chat-head]');

    const homeState = phase >= 7 ? 'done' : phase === 6 ? 'review' : phase >= 3 ? 'run' : 'todo';
    const docsState = phase >= 9 ? 'done' : phase === 8 ? 'review' : phase >= 4 ? 'run' : 'todo';
    if (taskHome) taskHome.dataset.state = homeState;
    if (taskDocs) taskDocs.dataset.state = docsState;
    if (run) {
      run.dataset.done = phase >= 9 ? '2' : phase >= 7 ? '1' : '0';
      run.dataset.total = phase >= 4 ? '2' : '1';
    }
    if (taskCount) {
      taskCount.textContent = phase >= 4 ? '2' : phase >= 3 ? '1' : '0';
      taskCount.hidden = phase < 3;
    }

    sessionHome?.classList.toggle('is-idle', phase >= 7);
    sessionDocs?.classList.toggle('is-idle', phase >= 9);
    const orchestratorActive = phase >= 2 && phase < 9;
    sessionOrchestrator?.classList.toggle('is-idle', !orchestratorActive);
    chatHead?.classList.toggle('is-idle', !orchestratorActive);
    if (chatHead)
      chatHead.dataset.state = orchestratorActive ? 'run' : phase >= 9 ? 'done' : 'idle';

    const showTasks = phase >= 3;
    if (panelFiles) panelFiles.hidden = showTasks;
    if (panelTasks) panelTasks.hidden = !showTasks;
    for (const tab of panelTabs) {
      tab.classList.toggle('is-active', (tab.dataset.panelTab === 'tasks') === showTasks);
    }
  }

  function renderModelScene(element, phase) {
    const taskImpl = element.querySelector('[data-task="model-impl"]');
    const taskReview = element.querySelector('[data-task="model-review"]');
    const taskCount = element.querySelector('[data-task-count]');
    const run = element.querySelector('[data-run]');
    if (taskImpl)
      taskImpl.dataset.state =
        phase >= 7 ? 'done' : phase >= 5 ? 'review' : phase >= 3 ? 'run' : 'todo';
    if (taskReview)
      taskReview.dataset.state =
        phase >= 7 ? 'done' : phase >= 6 ? 'review' : phase >= 5 ? 'run' : 'todo';
    if (run) {
      run.dataset.done = phase >= 7 ? '2' : '0';
      run.dataset.total = phase >= 4 ? '2' : phase >= 3 ? '1' : '0';
    }
    if (taskCount) {
      taskCount.textContent = phase >= 4 ? '2' : phase >= 3 ? '1' : '0';
      taskCount.hidden = phase < 3;
    }

    const sessionOrchestrator = element.querySelector('[data-session="model-orchestrator"]');
    const sessionImpl = element.querySelector('[data-session="model-impl"]');
    const sessionReview = element.querySelector('[data-session="model-review"]');
    const orchestratorActive = phase >= 2 && phase < 7;
    sessionOrchestrator?.classList.toggle('is-idle', !orchestratorActive);
    sessionImpl?.classList.toggle('is-idle', phase < 3 || phase >= 5);
    sessionReview?.classList.toggle('is-idle', phase < 5 || phase >= 6);

    const chatHead = element.querySelector('[data-chat-head]');
    chatHead?.classList.toggle('is-idle', !orchestratorActive);
    if (chatHead)
      chatHead.dataset.state = orchestratorActive ? 'run' : phase >= 7 ? 'done' : 'idle';

    const showTasks = phase >= 3;
    const panelFiles = element.querySelector('[data-panel-view="files"]');
    const panelTasks = element.querySelector('[data-panel-view="tasks"]');
    if (panelFiles) panelFiles.hidden = showTasks;
    if (panelTasks) panelTasks.hidden = !showTasks;
    for (const tab of element.querySelectorAll('[data-panel-tab]')) {
      tab.classList.toggle('is-active', (tab.dataset.panelTab === 'tasks') === showTasks);
    }
  }

  function renderRoleScene(element, phase) {
    // 0/4 打开新建会话：0 选 Worker，4 选自定义审查员；5 之后切到审查会话。
    const picked = phase === 0 ? 'worker' : phase === 4 ? 'review' : '';
    const modal = element.querySelector('[data-newsession]');
    if (modal) modal.hidden = !picked;
    for (const option of element.querySelectorAll('[data-role-option]')) {
      option.classList.toggle('is-picked', option.dataset.roleOption === picked);
    }

    const workerLive = phase >= 1 && phase < 5;
    const reviewLive = phase >= 5;
    const running = phase === 2 || phase === 5;
    const activeRole = workerLive ? 'worker' : reviewLive ? 'review' : '';

    const sessionWorker = element.querySelector('[data-session="role-worker"]');
    const sessionReview = element.querySelector('[data-session="role-review"]');
    sessionWorker?.classList.toggle('is-active', workerLive);
    sessionWorker?.classList.toggle('is-idle', !(running && workerLive));
    sessionReview?.classList.toggle('is-active', reviewLive);
    sessionReview?.classList.toggle('is-idle', !(running && reviewLive));

    const head = element.querySelector('[data-role-head]');
    // 运行点只看当前阶段是否真的在跑；已完成但选中的会话仍保持 idle。
    head?.classList.toggle('is-idle', !running);
    if (head) head.dataset.state = !activeRole ? 'idle' : running ? 'run' : 'done';
    for (const title of element.querySelectorAll('[data-role-title]')) {
      title.hidden = title.dataset.roleTitle !== activeRole;
    }
    for (const chip of element.querySelectorAll('[data-role-chip]')) {
      chip.hidden = chip.dataset.roleChip !== activeRole;
    }

    // 两个角色会话各自成段：审查阶段只显示审查会话，重播时不残留上一段消息。
    const workerChat = element.querySelector('[data-role-chat="worker"]');
    const reviewChat = element.querySelector('[data-role-chat="review"]');
    if (workerChat) workerChat.hidden = phase === 0 || phase >= 5;
    if (reviewChat) reviewChat.hidden = phase < 5;
    const reviewEmpty = element.querySelector('[data-role-empty]');
    if (reviewEmpty) reviewEmpty.hidden = phase !== 5;

    const reviewMode = phase >= 5;
    for (const placeholder of element.querySelectorAll('[data-role-placeholder]')) {
      placeholder.hidden = (placeholder.dataset.rolePlaceholder === 'review') !== reviewMode;
    }

    for (const card of element.querySelectorAll('[data-role-card]')) {
      const isActive = card.dataset.roleCard === activeRole;
      card.dataset.state = isActive ? (running ? 'run' : 'done') : 'idle';
    }
  }

  function renderQueueScene(element, phase) {
    const queued = phase >= 5 ? 0 : phase >= 4 ? 1 : phase >= 3 ? 2 : phase >= 1 ? 1 : 0;
    const queue = element.querySelector('[data-queue]');
    const count = element.querySelector('[data-queue-count]');
    const first = element.querySelector('[data-queue-item="1"]');
    const second = element.querySelector('[data-queue-item="2"]');
    if (queue) queue.hidden = queued === 0;
    if (count) count.textContent = String(queued);
    // 当前回合结束时第一条出队进入时间线，队列里只剩第二条。
    if (first) first.hidden = !(phase >= 1 && phase < 4);
    if (second) second.hidden = !(phase >= 3 && phase < 5);

    const current = element.querySelector('[data-queue-current]');
    if (current) current.dataset.done = String(phase >= 4);

    const running = phase < 5;
    const chatHead = element.querySelector('[data-chat-head]');
    chatHead?.classList.toggle('is-idle', !running);
    if (chatHead) chatHead.dataset.state = running ? 'run' : 'done';

    const composerInput = element.querySelector('.fd-composer-input');
    if (composerInput) composerInput.dataset.mode = running ? 'queue' : 'idle';

    const send = element.querySelector('[data-send]');
    if (send) send.dataset.mode = running ? 'queue' : 'idle';

    const task = element.querySelector('[data-queue-task]');
    if (task) task.dataset.state = running ? 'run' : 'done';
    const session = element.querySelector('[data-session="queue-current"]');
    session?.classList.toggle('is-idle', !running);
  }

  function createScene(host, name, element, config) {
    const appear = [...element.querySelectorAll('[data-appear]')];
    const timeline = element.querySelector('[data-timeline]');
    const empty = element.querySelector('[data-empty]');
    const typed = element.querySelector('[data-typed]');
    const input = element.querySelector('.fd-composer-input');
    const send = element.querySelector('[data-send]');
    const LAST = config.durations.length - 1;
    // 减少动画时停在可读的静态阶段；旧场景默认停在最终结果。
    const STATIC = Number.isInteger(config.staticPhase)
      ? Math.max(0, Math.min(LAST, config.staticPhase))
      : LAST;
    // 旧场景只有一个输入阶段；queue 用 typing 声明多个阶段，各阶段对应一段输入文本。
    const typing = config.typing?.length
      ? config.typing
      : [{ phase: config.typePhase, text: config.text }];
    const typePhases = new Set(typing.map((entry) => entry.phase));
    const state = {
      phase: 0,
      typedIndex: 0,
      autoTimer: 0,
      typeTimer: 0,
      running: false,
      // 当前阶段还剩多少毫秒推进；离屏/隐藏暂停后只补这部分。
      deadline: 0,
      remaining: 0,
    };

    function typedText(phase) {
      const entry = typing.find((item) => item.phase === phase);
      // 非输入阶段需要沿用最近一段文本（旧场景提交后保持到下一阶段）。
      return (entry ?? typing[typing.length - 1])?.text(locale()) ?? '';
    }

    function keepsTypedText(phase) {
      if (Array.isArray(config.keepTextPhases)) return config.keepTextPhases.includes(phase);
      if (typeof config.keepTextUntil !== 'number') return false;
      return phase > config.typePhase && phase <= config.keepTextUntil;
    }

    function isShown() {
      // 文档用 hidden 切换正文：祖先不可见时容器没有布局盒，必须一起停。
      return host.root.getClientRects().length > 0;
    }

    function shouldRun() {
      // 只在真正离屏、切走文档、页签隐藏或减少动画时停下；鼠标停在演示窗上不暂停。
      return host.activeScene === api && host.inView && isShown() && !document.hidden && !motion.matches;
    }

    function clearAuto() {
      if (state.autoTimer) window.clearTimeout(state.autoTimer);
      state.autoTimer = 0;
      state.remaining = 0;
    }

    // 暂停时记下当前阶段剩余时间，恢复后只等剩下的部分，不重等整个阶段。
    function pauseAuto() {
      if (!state.autoTimer) return;
      window.clearTimeout(state.autoTimer);
      state.autoTimer = 0;
      state.remaining = Math.max(0, state.deadline - performance.now());
    }

    function clearTypewriter() {
      if (!state.typeTimer) return;
      window.clearInterval(state.typeTimer);
      state.typeTimer = 0;
    }

    function setTyped(text) {
      if (!typed) return;
      typed.textContent = text;
      input?.classList.toggle('has-text', text.length > 0);
    }

    function tickTypewriter() {
      if (!shouldRun()) return;
      const full = typedText(state.phase);
      if (state.typedIndex >= full.length) {
        setTyped(full);
        clearTypewriter();
        return;
      }
      state.typedIndex += 1;
      setTyped(full.slice(0, state.typedIndex));
      if (state.typedIndex >= full.length) clearTypewriter();
    }

    function startTypewriter(reset) {
      const full = typedText(state.phase);
      clearTypewriter();
      if (reset) {
        state.typedIndex = 0;
        setTyped('');
      }
      if (motion.matches) {
        state.typedIndex = full.length;
        setTyped(full);
        return;
      }
      if (!shouldRun()) return;
      if (state.typedIndex >= full.length) {
        setTyped(full);
        return;
      }
      tickTypewriter();
      if (state.typedIndex < full.length) {
        state.typeTimer = window.setInterval(tickTypewriter, TYPE_INTERVAL);
      }
    }

    function scrollTimeline(toTop) {
      if (!timeline) return;
      window.requestAnimationFrame(() => {
        timeline.scrollTop = toTop ? 0 : timeline.scrollHeight;
      });
    }

    function scheduleNext() {
      const typingNow = typePhases.has(state.phase);
      const full = typingNow ? typedText(state.phase) : '';
      let delay;
      if (typingNow) {
        // 按实际剩余字符计时：打完再留一小段阅读停留就推进。
        delay = Math.max(0, full.length - state.typedIndex) * TYPE_INTERVAL + TYPE_SETTLE;
      } else if (state.remaining > 0) {
        delay = state.remaining;
      } else {
        delay = state.phase === LAST ? END_HOLD : config.durations[state.phase];
      }
      clearAuto();
      state.deadline = performance.now() + delay;
      state.autoTimer = window.setTimeout(() => {
        state.autoTimer = 0;
        if (!shouldRun()) return;
        // 计时器被节流时先补完剩余文字，绝不跳字推进。
        if (typePhases.has(state.phase) && state.typedIndex < typedText(state.phase).length) {
          if (!state.typeTimer) startTypewriter(false);
          scheduleNext();
          return;
        }
        // 最后一个阶段的结果停留结束后让位给下一个场景；单场景容器则原地重播。
        if (state.phase !== LAST) {
          applyPhase(state.phase + 1);
          return;
        }
        // 切场景的回调由 initDemo 在激活前挂到 host 上：createScene 不引用它的词法作用域。
        const nextScene = host.scenes[config.next];
        if (nextScene && nextScene !== api) host.selectScene(config.next);
        else activate();
      }, delay);
    }

    function sync() {
      const run = shouldRun();
      element.dataset.active = String(run);
      host.root.dataset.active = String(run);
      if (!run) {
        pauseAuto();
        clearTypewriter();
        state.running = false;
        return;
      }

      const resumed = !state.running;
      state.running = true;

      const typingNow = typePhases.has(state.phase);
      const full = typingNow ? typedText(state.phase) : '';
      if (typingNow && state.typedIndex < full.length && !state.typeTimer) {
        startTypewriter(false);
      }

      // 正在跑且计时器有效时不要重新排队：可见性等重复回调不该延长当前阶段。
      if (!resumed && state.autoTimer) return;
      scheduleNext();
    }

    function applyPhase(next) {
      clearAuto();
      clearTypewriter();
      state.phase = Math.max(0, Math.min(LAST, next));
      element.dataset.phase = String(state.phase);

      for (const node of appear) {
        node.classList.toggle('is-shown', Number(node.dataset.appear) <= state.phase);
      }
      if (empty) empty.hidden = state.phase >= config.emptyUntil;

      const full = typedText(state.phase);
      if (typePhases.has(state.phase)) {
        startTypewriter(true);
      } else if (keepsTypedText(state.phase)) {
        state.typedIndex = full.length;
        setTyped(full);
      } else {
        state.typedIndex = 0;
        setTyped('');
      }

      send?.classList.toggle('is-hot', config.hotPhases.includes(state.phase));
      config.render(element, state.phase);
      scrollTimeline(state.phase === 0);
      sync();
    }

    // 激活与“再点当前 tab 重播”共用：清掉旧 timer，从场景头（或减少动画的静态阶段）开始。
    function activate() {
      element.hidden = false;
      state.running = false;
      applyPhase(motion.matches ? STATIC : 0);
    }

    function deactivate() {
      clearAuto();
      clearTypewriter();
      state.running = false;
      element.dataset.active = 'false';
      host.root.dataset.active = 'false';
      element.hidden = true;
    }

    function localeChanged() {
      const full = typedText(state.phase);
      if (typePhases.has(state.phase)) {
        // 文本长度变了：重打当前语言并按新文本重新计时，避免旧计时器提前截断。
        clearAuto();
        if (shouldRun()) {
          startTypewriter(true);
        } else {
          state.typedIndex = full.length;
          setTyped(full);
        }
      } else if (keepsTypedText(state.phase)) {
        state.typedIndex = full.length;
        setTyped(full);
      } else {
        state.typedIndex = 0;
        setTyped('');
      }
      config.render(element, state.phase);
      scrollTimeline(state.phase === 0);
      sync();
    }

    function handleMotion() {
      if (motion.matches) {
        applyPhase(STATIC);
      } else if (state.phase === STATIC) {
        applyPhase(0);
      } else {
        sync();
      }
    }

    const api = {
      name,
      activate,
      deactivate,
      // 手动再次点击当前 tab 时重播；自动轮播只调 selectScene。
      restart: activate,
      localeChanged,
      handleMotion,
      sync,
    };
    return api;
  }

  // 一个 [data-demo] 容器 = 一套独立的场景状态、计时器与可见性观察。
  function initDemo(root) {
    const app = root.querySelector('[data-demo-app]');
    if (!app || root.dataset.demoReady === 'true') return;
    root.dataset.demoReady = 'true';

    const host = { root, inView: false, activeScene: null, scenes: {} };
    const scenes = host.scenes;
    const hasObserver = 'IntersectionObserver' in window;
    // 交给 IntersectionObserver 的首次回调决定是否开始，避免加载瞬间先跑几帧。
    host.inView = !hasObserver;

    const sceneConfigs = [
      [
        'collab',
        {
          durations: [0, 900, 750, 800, 750, 1000, 900, 950, 1100, 0],
          typePhase: 0,
          keepTextUntil: 1,
          emptyUntil: 2,
          hotPhases: [1],
          text: (lang) => collabText[lang],
          next: 'model',
          render: renderCollabScene,
        },
      ],
      [
        'model',
        {
          durations: [0, 850, 800, 800, 950, 900, 1100, 0],
          typePhase: 0,
          keepTextUntil: 1,
          emptyUntil: 2,
          hotPhases: [1],
          text: (lang) => modelText[lang],
          next: 'queue',
          render: renderModelScene,
        },
      ],
      [
        'queue',
        {
          // 0/2 各打一段后续需求；1/3 提交后清空输入；4/5 当前回合结束并按顺序接续队列。
          durations: [0, 800, 0, 750, 900, 600, 0],
          // 减少动画时停在“当前回合运行 + 两条排队消息”。
          staticPhase: 3,
          typing: [
            { phase: 0, text: (lang) => queueText.first[lang] },
            { phase: 2, text: (lang) => queueText.second[lang] },
          ],
          hotPhases: [0, 2],
          next: 'roles',
          render: renderQueueScene,
        },
      ],
      [
        'roles',
        {
          // 0/4 新建会话选角色；2/5 直接向该会话输入；3/6/7 保留该角色的回复结果。
          durations: [550, 160, 0, 1300, 550, 0, 1500, 0],
          // 减少动画时停在审查员的只读审查结果，两个会话和自定义标记仍然可见。
          staticPhase: 7,
          typing: [
            { phase: 2, text: (lang) => roleText.worker[lang] },
            { phase: 5, text: (lang) => roleText.review[lang] },
          ],
          hotPhases: [2, 5],
          emptyUntil: 3,
          next: 'collab',
          render: renderRoleScene,
        },
      ],
    ];

    // 只注册当前容器里真实存在的场景：首页四个 tab，文档每个示例只放一个场景。
    for (const [name, config] of sceneConfigs) {
      const element = root.querySelector(`[data-scene="${name}"]`);
      if (element) scenes[name] = createScene(host, name, element, config);
    }

    const sceneButtons = [...root.querySelectorAll('[data-scene-btn]')];
    const sceneSwitch = root.querySelector('.fd-scene-switch');

    // 滑块按当前按钮的实测位置对齐，换语言、字体或窗口宽度变化后重新测量。
    function moveScenePill() {
      if (!sceneSwitch) return;
      const pressed = sceneSwitch.querySelector('.fd-scene-btn[aria-pressed="true"]');
      if (!pressed) return;
      const track = sceneSwitch.getBoundingClientRect();
      const pill = pressed.getBoundingClientRect();
      const style = sceneSwitch.style;
      style.setProperty('--fd-scene-pill-x', `${pill.left - track.left - sceneSwitch.clientLeft}px`);
      style.setProperty('--fd-scene-pill-y', `${pill.top - track.top - sceneSwitch.clientTop}px`);
      style.setProperty('--fd-scene-pill-w', `${pill.width}px`);
      style.setProperty('--fd-scene-pill-h', `${pill.height}px`);
    }

    // 自动轮播只传场景名；手动点击带 restart，当前 tab 再点一次会从头重播。
    function selectScene(name, restart) {
      const next = scenes[name];
      if (!next) return;
      if (next === host.activeScene) {
        if (restart) next.restart();
        return;
      }
      host.activeScene?.deactivate();
      host.activeScene = next;
      for (const button of sceneButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.sceneBtn === name));
      }
      moveScenePill();
      next.activate();
    }

    // 供 createScene 的阶段计时器调用，保持每个容器自己的切场景实现。
    host.selectScene = selectScene;

    for (const button of sceneButtons) {
      button.addEventListener('click', () => selectScene(button.dataset.sceneBtn, true));
    }

    if (sceneSwitch && 'ResizeObserver' in window) {
      new ResizeObserver(moveScenePill).observe(sceneSwitch);
    }

    if (hasObserver) {
      const observer = new IntersectionObserver(
        (entries) => {
          host.inView = entries.some((entry) => entry.isIntersecting);
          host.activeScene?.sync();
        },
        { threshold: 0.08 }
      );
      observer.observe(root);
    }

    root.dataset.enhanced = 'true';

    // data-demo="roles" 之类的默认场景；没写或写错时用容器里注册的第一个场景。
    const initialName = scenes[root.dataset.demo] ? root.dataset.demo : Object.keys(scenes)[0];
    if (!initialName) return;
    host.activeScene = scenes[initialName];
    for (const button of sceneButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.sceneBtn === initialName));
    }
    moveScenePill();
    window.requestAnimationFrame(() => {
      if (sceneSwitch) sceneSwitch.dataset.ready = 'true';
    });

    // 文档里的单场景演示用小按钮重播；首页仍用四个 tab（再点当前 tab 也会重播）。
    root.querySelector('[data-demo-replay]')?.addEventListener('click', () => {
      host.activeScene?.restart();
    });

    instances.push({
      sync: () => host.activeScene?.sync(),
      handleMotion: () => host.activeScene?.handleMotion(),
      localeChanged: () => {
        moveScenePill();
        host.activeScene?.localeChanged();
      },
    });

    host.activeScene.activate();
  }

  for (const root of document.querySelectorAll('[data-demo]')) initDemo(root);

  const syncAll = () => {
    for (const instance of instances) instance.sync();
  };
  document.addEventListener('visibilitychange', syncAll);
  // 文档切换正文时补一次同步，避免离屏演示留下隐形计时器。
  document.addEventListener('fynvra:demos-visibility', syncAll);

  const handleMotionChange = () => {
    for (const instance of instances) instance.handleMotion();
  };
  if (typeof motion.addEventListener === 'function')
    motion.addEventListener('change', handleMotionChange);
  else motion.addListener(handleMotionChange);

  // 语言切换不重启动画：输入阶段重打当前语言，其余阶段沿用已显示的流程状态。
  new MutationObserver(() => {
    for (const instance of instances) instance.localeChanged();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-locale'],
  });
})();
