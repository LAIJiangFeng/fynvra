// 首页专属：顶部产品流程演示。
// 只操作 data-* 状态；语言跟随 <html data-locale>，不向外暴露内部接口。
(() => {
  const root = document.querySelector('[data-demo]');
  if (!root) return;

  const app = root.querySelector('[data-demo-app]');
  const timeline = root.querySelector('[data-timeline]');
  const empty = root.querySelector('[data-empty]');
  const typed = root.querySelector('[data-typed]');
  const input = root.querySelector('.fd-composer-input');
  const send = root.querySelector('[data-send]');
  const chatHead = root.querySelector('[data-chat-head]');
  const run = root.querySelector('[data-run]');
  const taskHome = root.querySelector('[data-task="home"]');
  const taskDocs = root.querySelector('[data-task="docs"]');
  const taskCount = root.querySelector('[data-task-count]');
  const panelFiles = root.querySelector('[data-panel-view="files"]');
  const panelTasks = root.querySelector('[data-panel-view="tasks"]');
  const panelTabs = [...root.querySelectorAll('[data-panel-tab]')];
  const sessionHome = root.querySelector('[data-session="home"]');
  const sessionDocs = root.querySelector('[data-session="docs"]');
  const sessionOrchestrator = root.querySelector('[data-session="orchestrator"]');
  const appear = [...root.querySelectorAll('[data-appear]')];
  const counters = [...root.querySelectorAll('[data-demo-counter]')];
  const chapterButtons = [...root.querySelectorAll('[data-chapter]')];
  const toggleButton = root.querySelector('[data-demo-toggle]');
  const replayButton = root.querySelector('[data-demo-replay]');
  const prevButton = root.querySelector('[data-demo-prev]');
  const nextButton = root.querySelector('[data-demo-next]');

  if (!app || !timeline) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const requestText = {
    zh: '优化官网首页：标题收紧一点，把顶部演示改成真实操作流程；文档页交给另一个 Worker。',
    en: 'Polish the homepage: smaller title, a real workflow demo. Give the docs page to another worker.',
  };

  // 每个相位只增加一层信息；同一套界面连续演完，不切换样板。
  const phases = [
    { delay: 1600 }, // 0 输入
    { delay: 2200 }, // 1 可发送
    { delay: 2200 }, // 2 用户消息 + 主 Agent 回复
    { delay: 2300 }, // 3 派发首页
    { delay: 2200 }, // 4 派发文档
    { delay: 2600 }, // 5 两个 Worker 执行
    { delay: 2200 }, // 6 首页待验收
    { delay: 2500 }, // 7 首页检查并合并
    { delay: 2200 }, // 8 文档待验收
    { delay: 0 }, // 9 全部完成
  ];
  const LAST = phases.length - 1;
  const chapterOf = [0, 0, 0, 1, 1, 2, 3, 3, 3, 4];

  let phase = 0;
  let paused = false;
  let inView = true;
  let autoTimer = 0;
  let typeTimer = 0;
  let typedIndex = 0;

  const locale = () => (document.documentElement.dataset.locale === 'en' ? 'en' : 'zh');
  const fullText = () => requestText[locale()];
  const shouldRun = () => !paused && !motion.matches && inView && !document.hidden;

  function clearAuto() {
    if (!autoTimer) return;
    window.clearTimeout(autoTimer);
    autoTimer = 0;
  }

  function clearTypewriter() {
    if (!typeTimer) return;
    window.clearInterval(typeTimer);
    typeTimer = 0;
  }

  function setTyped(text) {
    if (!typed) return;
    typed.textContent = text;
    input?.classList.toggle('has-text', text.length > 0);
  }

  function tickTypewriter() {
    if (!shouldRun()) return;
    const full = fullText();
    if (typedIndex >= full.length) {
      setTyped(full);
      clearTypewriter();
      return;
    }
    typedIndex += 1;
    setTyped(full.slice(0, typedIndex));
    if (typedIndex >= full.length) clearTypewriter();
  }

  function startTypewriter(reset) {
    if (reset) typedIndex = 0;
    clearTypewriter();
    if (motion.matches) {
      typedIndex = fullText().length;
      setTyped(fullText());
      return;
    }
    if (reset) setTyped('');
    // 手动分步时直接给出完整输入，便于停下来阅读。
    if (reset && paused) {
      typedIndex = fullText().length;
      setTyped(fullText());
      return;
    }
    if (!shouldRun()) return;
    tickTypewriter();
    if (typedIndex >= fullText().length) return;
    typeTimer = window.setInterval(tickTypewriter, 27);
  }

  function scrollTimeline() {
    window.requestAnimationFrame(() => {
      timeline.scrollTop = timeline.scrollHeight;
    });
  }

  function syncTimerState() {
    clearAuto();
    if (!shouldRun()) {
      clearTypewriter();
      return;
    }
    if (phase === 0 && !typeTimer && typedIndex < fullText().length) {
      startTypewriter(false);
    }
    if (phase >= LAST) return;
    autoTimer = window.setTimeout(() => {
      autoTimer = 0;
      applyPhase(phase + 1);
    }, phases[phase].delay);
  }

  function renderTasks() {
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
    sessionOrchestrator?.classList.toggle('is-idle', phase >= 9);
    chatHead?.classList.toggle('is-idle', phase >= 9);
    if (chatHead) chatHead.dataset.state = phase >= 9 ? 'done' : 'run';
  }

  function renderPanel() {
    const showTasks = phase >= 3;
    if (panelFiles) panelFiles.hidden = showTasks;
    if (panelTasks) panelTasks.hidden = !showTasks;
    for (const tab of panelTabs) {
      const active = (tab.dataset.panelTab === 'tasks') === showTasks;
      tab.classList.toggle('is-active', active);
    }
  }

  function renderControls() {
    root.dataset.paused = String(paused);
    root.dataset.atEnd = String(phase === LAST);
    if (toggleButton) {
      toggleButton.setAttribute('aria-pressed', String(paused));
      toggleButton.setAttribute('aria-disabled', String(phase === LAST || motion.matches));
      toggleButton.title = motion.matches
        ? '系统已启用减少动态效果 / Reduced motion is on'
        : '';
    }
    if (prevButton) prevButton.setAttribute('aria-disabled', String(phase === 0));
    if (nextButton) nextButton.setAttribute('aria-disabled', String(phase === LAST));
    for (const button of chapterButtons) {
      const target = Number(button.dataset.chapter);
      if (target === chapterOf[phase]) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    for (const counter of counters) counter.textContent = String(phase + 1);
  }

  function applyPhase(next) {
    phase = Math.min(LAST, Math.max(0, next));
    root.dataset.phase = String(phase);

    for (const element of appear) {
      element.classList.toggle('is-shown', Number(element.dataset.appear) <= phase);
    }
    if (empty) empty.hidden = phase >= 2;

    if (phase === 0) {
      startTypewriter(true);
    } else if (phase === 1) {
      clearTypewriter();
      typedIndex = fullText().length;
      setTyped(fullText());
    } else {
      clearTypewriter();
      typedIndex = 0;
      setTyped('');
    }

    send?.classList.toggle('is-hot', phase === 1);

    renderTasks();
    renderPanel();
    renderControls();
    scrollTimeline();
    syncTimerState();
  }

  function pauseForManual() {
    paused = true;
  }

  toggleButton?.addEventListener('click', () => {
    if (phase === LAST || motion.matches) return;
    paused = !paused;
    renderControls();
    syncTimerState();
  });

  replayButton?.addEventListener('click', () => {
    paused = false;
    applyPhase(0);
  });

  prevButton?.addEventListener('click', () => {
    if (phase === 0) return;
    pauseForManual();
    applyPhase(phase - 1);
  });

  nextButton?.addEventListener('click', () => {
    if (phase === LAST) return;
    pauseForManual();
    applyPhase(phase + 1);
  });

  for (const button of chapterButtons) {
    button.addEventListener('click', () => {
      pauseForManual();
      applyPhase(Number(button.dataset.chapter));
    });
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        syncTimerState();
      },
      { threshold: 0.08 }
    );
    observer.observe(root);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scrollTimeline();
    syncTimerState();
  });

  const handleMotion = () => {
    if (motion.matches) {
      paused = false;
      applyPhase(LAST);
    } else {
      renderControls();
      syncTimerState();
    }
  };
  if (typeof motion.addEventListener === 'function') motion.addEventListener('change', handleMotion);
  else motion.addListener(handleMotion);

  // 语言切换不重启动画，只把正在输入的演示文本换成当前语言。
  new MutationObserver(() => {
    if (phase === 0) {
      if (paused) {
        typedIndex = fullText().length;
        setTyped(fullText());
      } else {
        startTypewriter(true);
      }
    } else if (phase === 1) {
      setTyped(fullText());
    }
    scrollTimeline();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-locale'] });

  root.dataset.enhanced = 'true';
  applyPhase(motion.matches ? LAST : 0);
})();
