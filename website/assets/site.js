// Fynvra site — shared interactions. No dependencies, no build step.
(() => {
  const root = document.documentElement;
  const THEME_KEY = 'fynvra-site-theme';
  const LOCALE_KEY = 'fynvra-site-locale';
  const THEME_COLORS = { light: '#f1f5f2', dark: '#05080a' };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
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

  let locale = 'zh';
  let theme = 'dark';
  let statusRegion = null;
  const localeListeners = [];

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
      // Storage can be unavailable in private modes. The page still works for this visit.
    }
  }

  function toLocale(value) {
    const tag = String(value ?? '').toLowerCase();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
    return null;
  }

  function initialLocale() {
    const query = new URLSearchParams(window.location.search).get('lang');
    const fromQuery = toLocale(query);
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
    return 'dark';
  }

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

  function applyTheme(next) {
    theme = next;
    root.dataset.theme = next;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[next]);
    syncControls();
  }

  function applyLocale(next, options = {}) {
    locale = next;
    root.dataset.locale = next;
    root.lang = next === 'zh' ? 'zh-CN' : 'en';
    const title = next === 'zh' ? root.dataset.titleZh : root.dataset.titleEn;
    if (title) document.title = title;
    syncControls();
    for (const listener of localeListeners) listener();
    if (!options.silent) {
      const url = new URL(window.location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.delete('lang');
        try {
          window.history.replaceState(null, '', url);
        } catch {
          // file:// pages may not allow URL rewrites.
        }
      }
    }
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
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    writePref(THEME_KEY, next);
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

    button.addEventListener('click', () => {
      setOpen(button.getAttribute('aria-expanded') !== 'true');
    });

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

    window.matchMedia('(min-width: 981px)').addEventListener('change', (event) => {
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
      { rootMargin: '0px 0px -7% 0px', threshold: 0.08 }
    );
    for (const target of targets) observer.observe(target);
  }

  function setupDemo() {
    const demo = document.querySelector('[data-demo]');
    if (!demo) return;
    const tabs = [...demo.querySelectorAll('[role="tab"]')];
    const panels = [...demo.querySelectorAll('[data-demo-panel]')];
    if (tabs.length === 0 || tabs.length !== panels.length) return;
    let current = 0;

    const show = (next, moveFocus = false) => {
      current = (next + tabs.length) % tabs.length;
      for (let i = 0; i < tabs.length; i += 1) {
        const on = i === current;
        tabs[i].setAttribute('aria-selected', String(on));
        tabs[i].tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
        panels[i].classList.toggle('is-active', on);
      }
      if (moveFocus) tabs[current].focus();
    };

    for (let i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', () => show(i));
      tabs[i].addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          show(current + 1, true);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          show(current - 1, true);
        } else if (event.key === 'Home') {
          event.preventDefault();
          show(0, true);
        } else if (event.key === 'End') {
          event.preventDefault();
          show(tabs.length - 1, true);
        }
      });
    }

    show(0);
  }

  function setupScrollSpy() {
    const toc = document.querySelector('.toc');
    if (!toc) return;
    const list = toc.querySelector('ol');
    const links = [...toc.querySelectorAll('a[href^="#"]')];
    const sections = links
      .map((link) => document.getElementById(link.hash.slice(1)))
      .filter((section) => section !== null);
    if (sections.length === 0) return;
    let active = null;
    let frame = 0;

    const update = () => {
      frame = 0;
      let current = sections[0];
      for (const section of sections) {
        if (section.getBoundingClientRect().top > 170) break;
        current = section;
      }
      const page = document.documentElement;
      if (window.innerHeight + window.scrollY >= page.scrollHeight - 4) current = sections.at(-1);
      if (current === active) return;
      active = current;
      for (const link of links) {
        const on = link.hash === `#${current.id}`;
        if (on) {
          link.setAttribute('aria-current', 'true');
          if (list && list.scrollWidth > list.clientWidth) {
            const listRect = list.getBoundingClientRect();
            const linkRect = link.getBoundingClientRect();
            const delta = linkRect.left - listRect.left - (list.clientWidth - link.clientWidth) / 2;
            list.scrollTo({
              left: Math.max(0, list.scrollLeft + delta),
              behavior: reducedMotion.matches ? 'auto' : 'smooth',
            });
          }
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
    window.addEventListener('load', schedule);
    localeListeners.push(schedule);
    update();
  }

  function setupReadingProgress() {
    const bar = document.querySelector('[data-progress]');
    if (!bar) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      bar.style.width = `${(ratio * 100).toFixed(2)}%`;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('load', schedule);
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
    setupDemo();
    setupScrollSpy();
    setupReadingProgress();
  }

  // Set theme and language before first paint to avoid a flash of the wrong state.
  locale = initialLocale();
  theme = initialTheme();
  root.classList.add('js');
  applyLocale(locale, { silent: true });
  applyTheme(theme);

  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) return;
    for (const target of document.querySelectorAll('.reveal')) target.classList.add('is-visible');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
