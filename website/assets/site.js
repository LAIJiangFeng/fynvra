// 在 <head> 里同步执行：首帧绘制前定下主题与语言，DOM 就绪后再绑定交互
(() => {
  const root = document.documentElement;
  const THEME_KEY = 'fynvra-site-theme';
  const LOCALE_KEY = 'fynvra-site-locale';
  const FONT_URL =
    'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..900&family=JetBrains+Mono:wght@400..700&display=swap';
  const THEME_COLORS = { light: '#f3f1ec', dark: '#0f0f0d' };
  const STRINGS = {
    zh: {
      toDark: '切换到暗色主题',
      toLight: '切换到亮色主题',
      toggleLocale: 'Switch to English',
      openMenu: '打开菜单',
      closeMenu: '关闭菜单',
      copied: '已复制到剪贴板',
      copyFailed: '复制失败，请手动选择文本',
    },
    en: {
      toDark: 'Switch to dark theme',
      toLight: 'Switch to light theme',
      toggleLocale: '切换到中文',
      openMenu: 'Open menu',
      closeMenu: 'Close menu',
      copied: 'Copied to clipboard',
      copyFailed: 'Copy failed. Select the text manually',
    },
  };
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const localeListeners = [];
  let statusRegion = null;

  function readPref(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writePref(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // 存储不可用（隐私模式等）时只影响下次打开的默认值
    }
  }

  function toLocale(value) {
    const tag = String(value ?? '').toLowerCase();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
    return null;
  }

  function initialLocale() {
    const fromQuery = toLocale(new URLSearchParams(window.location.search).get('lang'));
    if (fromQuery) {
      writePref(LOCALE_KEY, fromQuery);
      return fromQuery;
    }
    const stored = toLocale(readPref(LOCALE_KEY));
    if (stored) return stored;
    return toLocale(navigator.languages?.[0] ?? navigator.language) === 'zh' ? 'zh' : 'en';
  }

  function initialTheme() {
    const stored = readPref(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return darkScheme.matches ? 'dark' : 'light';
  }

  let locale = initialLocale();
  let theme = initialTheme();

  function syncControls() {
    const strings = STRINGS[locale];
    const themeLabel = theme === 'dark' ? strings.toLight : strings.toDark;
    for (const button of document.querySelectorAll('[data-action="toggle-theme"]')) {
      button.setAttribute('aria-label', themeLabel);
      button.title = themeLabel;
    }
    for (const button of document.querySelectorAll('[data-action="toggle-locale"]')) {
      button.setAttribute('aria-label', strings.toggleLocale);
      button.title = strings.toggleLocale;
    }
    for (const button of document.querySelectorAll('[data-action="toggle-menu"]')) {
      const open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-label', open ? strings.closeMenu : strings.openMenu);
    }
  }

  function applyLocale(next) {
    locale = next;
    root.dataset.locale = next;
    root.lang = next === 'zh' ? 'zh-CN' : 'en';
    const title = next === 'zh' ? root.dataset.titleZh : root.dataset.titleEn;
    if (title) document.title = title;
    syncControls();
    for (const listener of localeListeners) listener();
  }

  function applyTheme(next) {
    theme = next;
    root.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[next]);
    syncControls();
  }

  root.classList.add('js');
  applyLocale(locale);
  applyTheme(theme);

  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = FONT_URL;
  document.head.append(fonts);

  darkScheme.addEventListener('change', (event) => {
    if (!readPref(THEME_KEY)) applyTheme(event.matches ? 'dark' : 'light');
  });

  function toggleTheme(event) {
    const next = theme === 'dark' ? 'light' : 'dark';
    const commit = () => {
      applyTheme(next);
      writePref(THEME_KEY, next);
    };
    if (!document.startViewTransition || reducedMotion.matches) {
      commit();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );
    const transition = document.startViewTransition(commit);
    transition.ready
      .then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          {
            duration: 520,
            easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
            pseudoElement: '::view-transition-new(root)',
          }
        );
      })
      .catch(() => {
        // 过渡被跳过时主题已经在 commit 里切换好了
      });
  }

  function scrollAnchor() {
    if (window.scrollY < 80) return null;
    let anchor = null;
    for (const section of document.querySelectorAll('main section[id]')) {
      if (section.getBoundingClientRect().top > 160) break;
      anchor = section;
    }
    return anchor;
  }

  function toggleLocale() {
    const next = locale === 'zh' ? 'en' : 'zh';
    const anchor = scrollAnchor();
    const before = anchor?.getBoundingClientRect().top ?? 0;
    applyLocale(next);
    writePref(LOCALE_KEY, next);
    if (anchor) {
      window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: 'instant' });
    }
    const url = new URL(window.location.href);
    if (!url.searchParams.has('lang')) return;
    url.searchParams.delete('lang');
    try {
      window.history.replaceState(null, '', url);
    } catch {
      // file:// 打开时部分浏览器不允许改写地址
    }
  }

  function bilingual(zh, en) {
    const fragment = document.createDocumentFragment();
    for (const [lang, text] of [
      ['zh', zh],
      ['en', en],
    ]) {
      const span = document.createElement('span');
      span.dataset.l = lang;
      span.textContent = text;
      fragment.append(span);
    }
    return fragment;
  }

  function announce(message) {
    if (!statusRegion) return;
    statusRegion.textContent = '';
    window.setTimeout(() => {
      statusRegion.textContent = message;
    }, 40);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    }
  }

  function setupCopy() {
    for (const block of document.querySelectorAll('.codeblock')) {
      const pre = block.querySelector('pre');
      if (!pre) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-btn';
      const idle = document.createElement('span');
      idle.className = 'copy-idle';
      idle.append(bilingual('复制', 'Copy'));
      const done = document.createElement('span');
      done.className = 'copy-done';
      done.append(bilingual('已复制', 'Copied'));
      button.append(idle, done);
      let timer = 0;
      button.addEventListener('click', async () => {
        const copied = await copyText(pre.textContent.trim());
        announce(STRINGS[locale][copied ? 'copied' : 'copyFailed']);
        if (!copied) return;
        button.dataset.state = 'done';
        window.clearTimeout(timer);
        timer = window.setTimeout(() => button.removeAttribute('data-state'), 1800);
      });
      block.append(button);
    }
  }

  function setupMenu() {
    const button = document.querySelector('[data-action="toggle-menu"]');
    const menu = document.getElementById('site-menu');
    if (!button || !menu) return;
    const setOpen = (open) => {
      button.setAttribute('aria-expanded', String(open));
      root.classList.toggle('menu-open', open);
      syncControls();
    };
    button.addEventListener('click', () =>
      setOpen(button.getAttribute('aria-expanded') !== 'true')
    );
    menu.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('click', (event) => {
      if (!root.classList.contains('menu-open')) return;
      if (event.target instanceof Element && !event.target.closest('.site-header')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !root.classList.contains('menu-open')) return;
      setOpen(false);
      button.focus();
    });
    window.matchMedia('(min-width: 901px)').addEventListener('change', (event) => {
      if (event.matches) setOpen(false);
    });
  }

  function setupHeader() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    const update = () => header.classList.toggle('is-scrolled', window.scrollY > 4);
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  function setupReveal() {
    const targets = document.querySelectorAll('.reveal');
    if (reducedMotion.matches || !('IntersectionObserver' in window)) {
      for (const target of targets) target.classList.add('is-visible');
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.1 }
    );
    for (const target of targets) observer.observe(target);
  }

  function setupScrollSpy() {
    const toc = document.querySelector('.toc');
    if (!toc) return;
    const list = toc.querySelector('ol');
    const links = [...toc.querySelectorAll('a[href^="#"]')];
    const sections = links
      .map((link) => document.getElementById(link.hash.slice(1)))
      .filter((section) => section !== null);
    if (!list || sections.length === 0) return;
    let active = null;
    let frame = 0;

    const reveal = (link) => {
      const behavior = reducedMotion.matches ? 'auto' : 'smooth';
      if (list.scrollWidth > list.clientWidth) {
        list.scrollTo({
          left: link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2,
          behavior,
        });
      } else if (toc.scrollHeight > toc.clientHeight) {
        toc.scrollTo({ top: link.offsetTop - toc.clientHeight / 2, behavior });
      }
    };

    const update = () => {
      frame = 0;
      let current = sections[0];
      for (const section of sections) {
        if (section.getBoundingClientRect().top > 150) break;
        current = section;
      }
      const page = document.documentElement;
      if (window.innerHeight + window.scrollY >= page.scrollHeight - 4) current = sections.at(-1);
      if (current === active) return;
      active = current;
      for (const link of links) {
        if (link.hash === `#${current.id}`) {
          link.setAttribute('aria-current', 'true');
          reveal(link);
        } else {
          link.removeAttribute('aria-current');
        }
      }
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    localeListeners.push(schedule);
    update();
  }

  function ready() {
    statusRegion = document.createElement('p');
    statusRegion.className = 'sr-only';
    statusRegion.setAttribute('aria-live', 'polite');
    document.body.append(statusRegion);

    for (const button of document.querySelectorAll('[data-action="toggle-theme"]')) {
      button.addEventListener('click', toggleTheme);
    }
    for (const button of document.querySelectorAll('[data-action="toggle-locale"]')) {
      button.addEventListener('click', toggleLocale);
    }
    syncControls();
    setupMenu();
    setupHeader();
    setupCopy();
    setupReveal();
    setupScrollSpy();
    setupStage();
    setupBench();
  }

  function setupBench() {
    const bench = document.querySelector('[data-bench]');
    if (!bench) return;
    const tabs = [...bench.querySelectorAll('[data-view]')];
    const panels = [...bench.querySelectorAll('[data-panel]')];
    const sides = [...bench.querySelectorAll('[data-side]')];
    const typed = bench.querySelector('[data-typed]');
    const send = bench.querySelector('[data-send]');
    const lines = {
      zh: '结账在库存不足时仍返回 200。修掉它，并补一条回归测试。',
      en: 'Checkout still returns 200 when stock is short. Fix it and add a regression test.',
    };
    let index = 0;
    let typeTimer = 0;
    let advanceTimer = 0;
    let paused = false;

    const play = (node) => {
      node.classList.remove('is-play');
      void node.offsetWidth;
      node.classList.add('is-play');
    };

    const typeLine = () => {
      window.clearInterval(typeTimer);
      if (!typed) return;
      const text = lines[locale] || lines.zh;
      if (reducedMotion.matches) {
        typed.textContent = text;
        send?.classList.add('is-hot');
        return;
      }
      typed.textContent = '';
      send?.classList.remove('is-hot');
      let count = 0;
      typeTimer = window.setInterval(() => {
        count += 1;
        typed.textContent = text.slice(0, count);
        if (count < text.length) return;
        window.clearInterval(typeTimer);
        send?.classList.add('is-hot');
      }, 42);
    };

    const show = (next) => {
      index = (next + tabs.length) % tabs.length;
      const view = tabs[index].dataset.view;
      for (let i = 0; i < tabs.length; i += 1) {
        const on = i === index;
        tabs[i].setAttribute('aria-selected', String(on));
        tabs[i].tabIndex = on ? 0 : -1;
      }
      for (const panel of panels) {
        const on = panel.dataset.panel === view;
        panel.hidden = !on;
        if (on) play(panel);
      }
      for (const side of sides) {
        const on = side.dataset.side === view;
        side.hidden = !on;
        if (on) play(side);
      }
      if (view === 'type') typeLine();
      else window.clearInterval(typeTimer);
    };

    const arm = () => {
      window.clearInterval(advanceTimer);
      if (paused || reducedMotion.matches) return;
      advanceTimer = window.setInterval(() => show(index + 1), 7000);
    };

    for (let i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', () => {
        show(i);
        arm();
      });
    }
    bench.addEventListener('mouseenter', () => {
      paused = true;
      window.clearInterval(advanceTimer);
    });
    bench.addEventListener('mouseleave', () => {
      paused = false;
      arm();
    });
    localeListeners.push(() => {
      if (tabs[index]?.dataset.view === 'type') typeLine();
    });
    show(0);
    arm();
  }

  function setupStage() {
    const stage = document.querySelector('[data-stage]');
    if (!stage) return;
    const tabs = [...stage.querySelectorAll('[role="tab"]')];
    const panels = [...stage.querySelectorAll('[data-scene-panel]')];
    if (tabs.length === 0 || tabs.length !== panels.length) return;
    let index = 0;
    let timer = 0;
    let paused = false;

    const show = (next) => {
      index = (next + tabs.length) % tabs.length;
      for (let i = 0; i < tabs.length; i += 1) {
        const on = i === index;
        tabs[i].setAttribute('aria-selected', String(on));
        tabs[i].tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
        panels[i].classList.toggle('is-on', on);
        if (!on) continue;
        panels[i].classList.remove('is-play');
        void panels[i].offsetWidth;
        panels[i].classList.add('is-play');
      }
    };

    const arm = () => {
      window.clearInterval(timer);
      if (paused || reducedMotion.matches) return;
      timer = window.setInterval(() => show(index + 1), 6800);
    };

    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      tab.addEventListener('click', () => {
        show(i);
        arm();
      });
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const next = (index + delta + tabs.length) % tabs.length;
        tabs[next].focus();
        show(next);
        arm();
      });
    }

    stage.addEventListener('mouseenter', () => {
      paused = true;
      window.clearInterval(timer);
    });
    stage.addEventListener('mouseleave', () => {
      paused = false;
      arm();
    });
    stage.addEventListener('focusin', () => {
      paused = true;
      window.clearInterval(timer);
    });
    stage.addEventListener('focusout', (event) => {
      if (stage.contains(event.relatedTarget)) return;
      paused = false;
      arm();
    });

    show(0);
    arm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
