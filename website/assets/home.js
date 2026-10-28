// 首页专属：顶部产品流程演示（任务协作 / 指定 Worker 模型）。
// 两个场景各自持有计时器与状态；只操作 data-* 和 class，语言跟随 <html data-locale>。
(() => {
  const root = document.querySelector('[data-demo]');
  if (!root) return;
  const app = root.querySelector('[data-demo-app]');
  if (!app) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hoverCapable = window.matchMedia('(hover: hover)');
  const TYPE_INTERVAL = 27;
  const END_HOLD = 3000;

  const collabText = {
    zh: '优化官网首页：标题收紧一点，把顶部演示改成真实操作流程；文档页交给另一个 Worker。',
    en: 'Polish the homepage: smaller title, a real workflow demo. Give the docs page to another worker.',
  };
  const modelText = {
    zh: '让实现侧栏折叠的 Worker 用 DeepSeek，审查改动的 Worker 用 GPT。',
    en: 'Use DeepSeek for the worker implementing sidebar collapse, and GPT for the worker reviewing the diff.',
  };

  const locale = () => (document.documentElement.dataset.locale === 'en' ? 'en' : 'zh');
  const typingDelay = (text) => Math.max(2200, text.length * TYPE_INTERVAL + 700);

  let inView = true;
  let appHovered = false;
  let activeScene = null;

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

  function createScene(name, element, config) {
    const appear = [...element.querySelectorAll('[data-appear]')];
    const timeline = element.querySelector('[data-timeline]');
    const empty = element.querySelector('[data-empty]');
    const typed = element.querySelector('[data-typed]');
    const input = element.querySelector('.fd-composer-input');
    const send = element.querySelector('[data-send]');
    const LAST = config.durations.length - 1;
    const state = { phase: 0, typedIndex: 0, autoTimer: 0, typeTimer: 0 };

    function shouldRun() {
      return activeScene === api && inView && !document.hidden && !motion.matches && !appHovered;
    }

    function clearAuto() {
      if (!state.autoTimer) return;
      window.clearTimeout(state.autoTimer);
      state.autoTimer = 0;
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
      const full = config.text(locale());
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
      const full = config.text(locale());
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

    function sync() {
      const run = shouldRun();
      element.dataset.active = String(run);
      root.dataset.active = String(run);
      clearAuto();
      if (!run) {
        clearTypewriter();
        return;
      }

      const full = config.text(locale());
      if (state.phase === config.typePhase && state.typedIndex < full.length && !state.typeTimer) {
        startTypewriter(false);
      }

      const delay =
        state.phase === config.typePhase
          ? typingDelay(full)
          : state.phase === LAST
            ? END_HOLD
            : config.durations[state.phase];
      state.autoTimer = window.setTimeout(() => {
        state.autoTimer = 0;
        if (!shouldRun()) return;
        // 最后一个阶段的结果停留结束后让位给另一个场景，两个场景按顺序无限交替。
        if (state.phase === LAST) selectScene(config.next);
        else applyPhase(state.phase + 1);
      }, delay);
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

      const full = config.text(locale());
      if (state.phase === config.typePhase) {
        startTypewriter(true);
      } else if (state.phase > config.typePhase && state.phase <= config.keepTextUntil) {
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

    function activate() {
      element.hidden = false;
      applyPhase(motion.matches ? LAST : 0);
    }

    function deactivate() {
      clearAuto();
      clearTypewriter();
      element.dataset.active = 'false';
      root.dataset.active = 'false';
      element.hidden = true;
    }

    function localeChanged() {
      const full = config.text(locale());
      if (state.phase === config.typePhase) {
        if (shouldRun()) {
          startTypewriter(true);
        } else {
          state.typedIndex = full.length;
          setTyped(full);
        }
      } else if (state.phase > config.typePhase && state.phase <= config.keepTextUntil) {
        state.typedIndex = full.length;
        setTyped(full);
      }
      config.render(element, state.phase);
      scrollTimeline(state.phase === 0);
      sync();
    }

    function handleMotion() {
      if (motion.matches) {
        applyPhase(LAST);
      } else if (state.phase === LAST) {
        applyPhase(0);
      } else {
        sync();
      }
    }

    const api = { name, activate, deactivate, localeChanged, handleMotion, sync };
    return api;
  }

  const collab = createScene('collab', root.querySelector('[data-scene="collab"]'), {
    durations: [0, 2200, 2200, 2300, 2200, 2600, 2200, 2500, 2200, 0],
    typePhase: 0,
    keepTextUntil: 1,
    emptyUntil: 2,
    hotPhases: [1],
    text: (lang) => collabText[lang],
    next: 'model',
    render: renderCollabScene,
  });

  const model = createScene('model', root.querySelector('[data-scene="model"]'), {
    durations: [0, 2200, 2800, 2200, 2800, 2600, 2400, 0],
    typePhase: 0,
    keepTextUntil: 1,
    emptyUntil: 2,
    hotPhases: [1],
    text: (lang) => modelText[lang],
    next: 'collab',
    render: renderModelScene,
  });

  const scenes = { collab, model };
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

  function selectScene(name) {
    const next = scenes[name];
    if (!next || next === activeScene) return;
    activeScene?.deactivate();
    activeScene = next;
    for (const button of sceneButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.sceneBtn === name));
    }
    moveScenePill();
    next.activate();
  }

  for (const button of sceneButtons) {
    button.addEventListener('click', () => selectScene(button.dataset.sceneBtn));
  }

  if (sceneSwitch && 'ResizeObserver' in window) {
    new ResizeObserver(moveScenePill).observe(sceneSwitch);
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        activeScene?.sync();
      },
      { threshold: 0.08 }
    );
    observer.observe(root);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && hoverCapable.matches) appHovered = app.matches(':hover');
    activeScene?.sync();
  });

  app.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse' || !hoverCapable.matches) return;
    appHovered = true;
    activeScene?.sync();
  });

  app.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    appHovered = false;
    activeScene?.sync();
  });

  const handleMotionChange = () => activeScene?.handleMotion();
  if (typeof motion.addEventListener === 'function')
    motion.addEventListener('change', handleMotionChange);
  else motion.addListener(handleMotionChange);

  // 语言切换不重启动画：输入阶段重打当前语言，其余阶段沿用已显示的流程状态。
  new MutationObserver(() => {
    moveScenePill();
    activeScene?.localeChanged();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-locale'],
  });

  root.dataset.enhanced = 'true';
  activeScene = scenes.collab;
  for (const button of sceneButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.sceneBtn === 'collab'));
  }
  moveScenePill();
  window.requestAnimationFrame(() => {
    if (sceneSwitch) sceneSwitch.dataset.ready = 'true';
  });
  activeScene.activate();
})();
