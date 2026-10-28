/*
 * Fynvra docs: static article routing, local full-text search, collapsible groups,
 * and a small-screen navigation drawer. No fetch, no dependencies, no server.
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    file: [
      'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z',
      'M14 3v5h5',
      'M9 13h6',
      'M9 17h4',
    ],
  };

  const STRINGS = {
    zh: {
      search: '搜索文档',
      clear: '清空搜索',
      resultsLabel: '搜索结果',
      noResults: '没有找到匹配的文档。试试更短的关键词，或改用目录浏览。',
      oneResult: '1 篇匹配',
      manyResults: (count) => `${count} 篇匹配`,
      onThisPage: '本页小节',
      previous: '上一篇',
      next: '下一篇',
      docsTitle: 'Fynvra 文档',
    },
    en: {
      search: 'Search docs',
      clear: 'Clear search',
      resultsLabel: 'Search results',
      noResults: 'No matching pages. Try a shorter keyword, or browse the navigation.',
      oneResult: '1 result',
      manyResults: (count) => `${count} results`,
      onThisPage: 'On this page',
      previous: 'Previous',
      next: 'Next',
      docsTitle: 'Fynvra Docs',
    },
  };

  function makeIcon(name, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className || 'doc-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICON_PATHS[name] || []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeWhitespace(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function init() {
    const app = document.body;
    if (!app || !app.classList.contains('docs-app')) return;
    if (window.__fynvraDocsInitialized) return;
    window.__fynvraDocsInitialized = true;

    const root = document.documentElement;
    const main = document.getElementById('main');
    const shell = document.querySelector('.docs-shell');
    const sidebar = document.getElementById('docs-sidebar');
    const navScroll = document.querySelector('[data-docs-nav-scroll]');
    const articles = Array.from(document.querySelectorAll('[data-doc-article]'));
    if (!main || !shell || !sidebar || !navScroll || articles.length === 0) return;

    const byId = new Map(articles.map((article) => [article.id, article]));
    const navLinks = Array.from(document.querySelectorAll('[data-doc-link]'));
    const groupToggles = Array.from(document.querySelectorAll('[data-docs-group]'));

    const searchWrap = document.querySelector('.docs-search-wrap');
    const searchInput = document.getElementById('docs-search-input');
    const searchClear = document.querySelector('[data-docs-search-clear]');
    const searchPanel = document.getElementById('docs-search-panel');
    const searchResults = document.getElementById('docs-search-results');
    const searchSummary = document.querySelector('[data-docs-search-summary]');
    const searchEmpty = document.querySelector('[data-docs-search-empty]');
    const kbdHint = document.querySelector('[data-docs-kbd]');

    const navToggle = document.querySelector('[data-docs-nav-toggle]');
    const navClose = document.querySelector('[data-docs-nav-close]');
    const scrim = document.querySelector('[data-docs-scrim]');
    const mobilebar = document.querySelector('.docs-mobilebar');
    const mobileCurrent = document.querySelector('[data-docs-mobile-current]');

    const breadcrumbGroup = document.querySelector('[data-docs-breadcrumb-group]');
    const breadcrumbCurrent = document.querySelector('[data-docs-breadcrumb-current]');
    const prevLink = document.querySelector('[data-docs-prev]');
    const prevTitle = document.querySelector('[data-docs-prev-title]');
    const nextLink = document.querySelector('[data-docs-next]');
    const nextTitle = document.querySelector('[data-docs-next-title]');

    if (!searchInput || !searchPanel || !searchResults) return;

    const isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
    const mobileQuery = window.matchMedia('(max-width: 900px)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const strings = () => STRINGS[locale];

    let locale = root.dataset.locale === 'en' ? 'en' : 'zh';
    let searchQuery = '';
    let cachedIndex = null;
    let activeArticle = null;
    let lastRouteKey = null;

    const articleTitle = (article) =>
      article.dataset[locale === 'zh' ? 'titleZh' : 'titleEn'] || article.id;
    const articleGroup = (article) =>
      article.dataset[locale === 'zh' ? 'groupZh' : 'groupEn'] || '';

    /** Text of node after dropping the other language and unwrapping the current one. */
    function localizedText(node) {
      if (!node) return '';
      const clone = node.cloneNode(true);
      for (const element of clone.querySelectorAll('button, script, style, noscript'))
        element.remove();
      for (const element of clone.querySelectorAll('[data-l]')) {
        if (element.getAttribute('data-l') !== locale) element.remove();
        else element.replaceWith(...element.childNodes);
      }
      // textContent joins block elements without whitespace; keep search excerpts readable.
      for (const element of clone.querySelectorAll(
        'h1, h2, h3, h4, p, li, dt, dd, th, td, pre, div, section, aside, header, footer, nav, ul, ol, table, tr'
      )) {
        element.append(document.createTextNode(' '));
      }
      return normalizeWhitespace(clone.textContent);
    }

    function buildIndex() {
      if (cachedIndex) return cachedIndex;
      cachedIndex = articles.map((article, order) => {
        const bodyNode = article.querySelector('.docs-article-body');
        const introNode = article.querySelector('.docs-lede');
        const heading = localizedText(article.querySelector('h1'));
        const body = localizedText(bodyNode);
        const intro = localizedText(introNode);
        const title = articleTitle(article);
        return {
          article,
          order,
          title,
          heading,
          group: articleGroup(article),
          intro,
          body,
          haystack: `${title} ${heading} ${intro} ${body}`.toLowerCase(),
        };
      });
      return cachedIndex;
    }

    function termsOf(query) {
      return query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0);
    }

    function snippetFor(item, terms) {
      const corpus = item.body || item.intro;
      if (!corpus) return '';
      const lower = corpus.toLowerCase();
      let first = -1;
      for (const term of terms) {
        const at = lower.indexOf(term);
        if (at >= 0 && (first < 0 || at < first)) first = at;
      }
      if (first < 0) {
        const heading = item.heading.toLowerCase();
        if (terms.some((term) => heading.includes(term))) {
          const fallback = `${item.heading}${item.intro ? ` — ${item.intro}` : ''}`;
          return `${fallback.slice(0, 190).trim()}${fallback.length > 190 ? ' …' : ''}`;
        }
        first = 0;
      }
      let start = Math.max(0, first - 52);
      let end = Math.min(corpus.length, first + 138);
      if (start > 0) {
        const boundary = corpus.lastIndexOf(' ', start);
        if (boundary > start - 30) start = boundary + 1;
      }
      if (end < corpus.length) {
        const boundary = corpus.indexOf(' ', end);
        if (boundary >= 0 && boundary < end + 30) end = boundary;
      }
      const text = corpus.slice(start, end).trim();
      return `${start > 0 ? '… ' : ''}${text}${end < corpus.length ? ' …' : ''}`;
    }

    function appendHighlighted(element, text, terms) {
      const usable = terms.filter(Boolean);
      if (usable.length === 0) {
        element.textContent = text;
        return;
      }
      const pattern = usable
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
      if (!pattern) {
        element.textContent = text;
        return;
      }
      const matcher = new RegExp(`(${pattern})`, 'gi');
      for (const part of String(text).split(matcher)) {
        if (!part) continue;
        if (usable.some((term) => part.toLowerCase() === term)) {
          const mark = document.createElement('mark');
          mark.textContent = part;
          element.append(mark);
        } else {
          element.append(document.createTextNode(part));
        }
      }
    }

    function updateSearchChrome() {
      const copy = strings();
      searchWrap.setAttribute('aria-label', copy.search);
      searchInput.setAttribute('aria-label', copy.search);
      searchInput.placeholder = copy.search;
      searchClear.setAttribute('aria-label', copy.clear);
      searchResults.setAttribute('aria-label', copy.resultsLabel);
      const hasQuery = searchQuery.trim().length > 0;
      searchWrap.classList.toggle('has-query', hasQuery);
      searchClear.hidden = !hasQuery;
    }

    function closeSearch(clear, focusInput) {
      searchPanel.hidden = true;
      if (clear) {
        searchQuery = '';
        searchInput.value = '';
        searchResults.replaceChildren();
        searchSummary.textContent = '';
        searchEmpty.hidden = true;
        searchEmpty.textContent = '';
        updateSearchChrome();
      }
      if (focusInput) searchInput.focus();
    }

    function renderSearchResults() {
      const query = searchQuery.trim();
      if (!query) {
        closeSearch(false, false);
        return;
      }
      const terms = termsOf(query);
      if (terms.length === 0) {
        closeSearch(false, false);
        return;
      }
      const word = query.toLowerCase();
      const matches = [];
      for (const item of buildIndex()) {
        let score = 0;
        let matched = true;
        for (const term of terms) {
          const inTitle =
            item.title.toLowerCase().includes(term) || item.heading.toLowerCase().includes(term);
          const inBody = item.haystack.includes(term);
          if (!inTitle && !inBody) {
            matched = false;
            break;
          }
          score += inTitle ? 7 : 2;
          if (item.intro.toLowerCase().includes(term)) score += 1;
        }
        if (!matched) continue;
        const title = item.title.toLowerCase();
        const heading = item.heading.toLowerCase();
        if (title.startsWith(word) || heading.startsWith(word)) score += 9;
        else if (title.includes(word) || heading.includes(word)) score += 4;
        matches.push({ item, score, snippet: snippetFor(item, terms) });
      }
      matches.sort((a, b) => b.score - a.score || a.item.order - b.item.order);

      searchResults.replaceChildren();
      const copy = strings();
      searchSummary.textContent =
        matches.length === 1 ? copy.oneResult : copy.manyResults(matches.length);
      searchEmpty.textContent = copy.noResults;
      searchEmpty.hidden = matches.length > 0;
      searchResults.hidden = matches.length === 0;

      for (const match of matches) {
        const listItem = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'docs-result';
        link.href = `#${match.item.article.id}`;
        link.setAttribute('data-doc-result', '');

        const copyBox = document.createElement('span');
        copyBox.className = 'docs-result-copy';
        const title = document.createElement('span');
        title.className = 'docs-result-title';
        appendHighlighted(title, match.item.title, terms);
        const excerpt = document.createElement('span');
        excerpt.className = 'docs-result-excerpt';
        appendHighlighted(excerpt, match.snippet, terms);
        const group = document.createElement('span');
        group.className = 'docs-result-group';
        group.textContent = match.item.group;
        copyBox.append(title, excerpt, group);

        link.append(makeIcon('file', 'doc-icon docs-result-icon'), copyBox);
        listItem.append(link);
        searchResults.append(listItem);
      }
      searchPanel.hidden = false;
    }

    function resultLinks() {
      return Array.from(searchResults.querySelectorAll('[data-doc-result]'));
    }

    function setGroupOpen(toggle, open) {
      toggle.setAttribute('aria-expanded', String(open));
      const panel = document.getElementById(toggle.getAttribute('aria-controls') || '');
      if (panel) panel.hidden = !open;
    }

    function openGroupFor(link) {
      const group = link ? link.closest('.docs-group') : null;
      const toggle = group ? group.querySelector('[data-docs-group]') : null;
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') setGroupOpen(toggle, true);
    }

    function ensureNavLinkVisible(link) {
      if (!link) return;
      const navRect = navScroll.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      if (linkRect.top < navRect.top + 8) {
        navScroll.scrollTop += linkRect.top - navRect.top - 12;
      } else if (linkRect.bottom > navRect.bottom - 8) {
        navScroll.scrollTop += linkRect.bottom - navRect.bottom + 12;
      }
    }

    function buildSubnav(link, article, anchorId) {
      const headings = Array.from(article.querySelectorAll('.docs-article-body h2[id]'));
      if (headings.length === 0) return;
      const list = document.createElement('ul');
      list.className = 'docs-nav-sub';
      list.setAttribute('aria-label', strings().onThisPage);
      for (const heading of headings) {
        const item = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = `#${heading.id}`;
        anchor.textContent = localizedText(heading);
        if (heading.id === anchorId) anchor.setAttribute('aria-current', 'location');
        item.append(anchor);
        list.append(item);
      }
      const navItem = link.closest('li');
      if (navItem) navItem.append(list);
    }

    function updateNav(article, anchorId, options) {
      const settings = options || {};
      for (const old of document.querySelectorAll('.docs-nav-sub')) old.remove();
      for (const link of navLinks) {
        const active = link.dataset.docLink === article.id;
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
        if (!active) continue;
        openGroupFor(link);
        buildSubnav(link, article, anchorId);
        if (settings.reveal !== false) {
          window.requestAnimationFrame(() => ensureNavLinkVisible(link));
        }
      }
    }

    function updateBreadcrumb(article) {
      if (breadcrumbGroup) breadcrumbGroup.textContent = articleGroup(article);
      if (breadcrumbCurrent) breadcrumbCurrent.textContent = articleTitle(article);
      if (mobileCurrent) mobileCurrent.textContent = articleTitle(article);
    }

    function setPagerLink(link, titleElement, article, label) {
      if (!link || !titleElement) return;
      if (!article) {
        link.hidden = true;
        link.removeAttribute('href');
        link.removeAttribute('aria-label');
        titleElement.textContent = '';
        return;
      }
      const title = articleTitle(article);
      link.hidden = false;
      link.href = `#${article.id}`;
      link.setAttribute('aria-label', `${label}: ${title}`);
      titleElement.textContent = title;
    }

    function updatePager(article) {
      const index = articles.indexOf(article);
      setPagerLink(prevLink, prevTitle, index > 0 ? articles[index - 1] : null, strings().previous);
      setPagerLink(
        nextLink,
        nextTitle,
        index >= 0 && index < articles.length - 1 ? articles[index + 1] : null,
        strings().next
      );
    }

    function updateDocumentTitle(article) {
      document.title = `${articleTitle(article)} — ${strings().docsTitle}`;
    }

    function updateArticleKicker(article) {
      if (!article) return;
      const kicker = article.querySelector('[data-docs-kicker]');
      if (kicker) kicker.textContent = articleGroup(article);
    }

    function resolveHash() {
      const raw = window.location.hash.slice(1);
      if (!raw) return { article: articles[0], anchor: null, key: '' };
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        id = raw;
      }
      const exact = byId.get(id);
      if (exact) return { article: exact, anchor: null, key: window.location.hash };
      const target = document.getElementById(id);
      const owner = target ? target.closest('[data-doc-article]') : null;
      if (owner) return { article: owner, anchor: id, key: window.location.hash };
      return { article: articles[0], anchor: null, key: window.location.hash };
    }

    function resetScroll() {
      main.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      if (mobileQuery.matches) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }

    function scrollToElement(element) {
      if (!element) return;
      const behavior = reducedMotion.matches ? 'auto' : 'smooth';
      const style = window.getComputedStyle(main);
      const mainScrolls =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        main.scrollHeight > main.clientHeight + 1;
      if (mainScrolls) {
        const mainRect = main.getBoundingClientRect();
        const top = main.scrollTop + element.getBoundingClientRect().top - mainRect.top - 20;
        main.scrollTo({ top: Math.max(0, top), behavior });
        return;
      }
      const header = document.querySelector('.site-header');
      const headerHeight = header ? header.getBoundingClientRect().height : 0;
      const barHeight =
        mobilebar && window.getComputedStyle(mobilebar).display !== 'none'
          ? mobilebar.getBoundingClientRect().height
          : 0;
      const top =
        window.scrollY + element.getBoundingClientRect().top - headerHeight - barHeight - 18;
      window.scrollTo({ top: Math.max(0, top), behavior });
    }

    function focusArticle(article, anchorId) {
      const target = anchorId ? document.getElementById(anchorId) : null;
      const focusTarget = target && article.contains(target) ? target : article.querySelector('h1');
      if (!focusTarget) return;
      if (focusTarget.tagName !== 'H1') focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    }

    function route(options) {
      const settings = options || {};
      const info = resolveHash();
      const article = info.article;
      const key = info.key;
      if (!settings.force && key === lastRouteKey && activeArticle === article) return;
      lastRouteKey = key;
      activeArticle = article;

      for (const candidate of articles) {
        const active = candidate === article;
        candidate.hidden = !active;
        candidate.classList.toggle('is-active', active);
      }
      updateNav(article, info.anchor);
      updateBreadcrumb(article);
      updatePager(article);
      updateDocumentTitle(article);
      updateArticleKicker(article);

      window.requestAnimationFrame(() => {
        if (info.anchor) {
          const target = document.getElementById(info.anchor);
          if (target && article.contains(target)) scrollToElement(target);
          else resetScroll();
        } else {
          resetScroll();
        }
        if (settings.focus) focusArticle(article, info.anchor);
      });
    }

    function navigate(hash, options) {
      const settings = options || {};
      const target = hash.startsWith('#') ? hash : `#${hash}`;
      if (window.location.hash === target) {
        route({ focus: settings.focus !== false, force: true });
        return;
      }
      let failure = false;
      try {
        window.history.pushState(null, '', target);
      } catch {
        failure = true;
      }
      if (failure) {
        // file:// in some browsers blocks pushState; the hashchange listener will route.
        window.location.hash = target;
        return;
      }
      route({ focus: settings.focus !== false, force: true });
    }

    function setNavOpen(open, options) {
      const settings = options || {};
      if (open && !mobileQuery.matches) return;
      app.classList.toggle('docs-nav-open', open);
      if (navToggle) navToggle.setAttribute('aria-expanded', String(open));
      if (scrim) scrim.hidden = !open;
      if (open) {
        main.inert = true;
        const activeLink = navLinks.find((link) => link.getAttribute('aria-current') === 'page');
        window.requestAnimationFrame(() => {
          if (activeLink) ensureNavLinkVisible(activeLink);
          if (settings.focus !== false) searchInput.focus();
        });
      } else {
        main.inert = false;
        if (!searchPanel.hidden) closeSearch(false, false);
        if (settings.restoreFocus) navToggle.focus();
      }
    }

    function refreshLocaleTexts() {
      updateSearchChrome();
      if (!activeArticle) return;
      const info = resolveHash();
      const anchorId = info.article === activeArticle ? info.anchor : null;
      updateNav(activeArticle, anchorId, { reveal: false });
      updateBreadcrumb(activeArticle);
      updatePager(activeArticle);
      updateDocumentTitle(activeArticle);
      updateArticleKicker(activeArticle);
      if (!searchPanel.hidden && searchQuery.trim()) renderSearchResults();
    }

    // Initial state and static chrome.
    root.classList.add('docs-ready');
    try {
      window.history.scrollRestoration = 'manual';
    } catch {
      // Older browsers may not expose scrollRestoration.
    }
    searchInput.value = '';
    updateSearchChrome();
    if (kbdHint) kbdHint.textContent = isMac ? '⌘ K' : 'Ctrl K';
    for (const article of articles) {
      const heading = article.querySelector('h1');
      if (heading) heading.tabIndex = -1;
      updateArticleKicker(article);
    }
    for (const toggle of groupToggles) {
      if (toggle.getAttribute('aria-expanded') !== 'true') setGroupOpen(toggle, false);
    }
    route({ focus: false, force: true });

    // Search input and results.
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      updateSearchChrome();
      if (!searchQuery.trim()) {
        closeSearch(false, false);
        return;
      }
      renderSearchResults();
    });

    searchInput.addEventListener('focus', () => {
      if (searchQuery.trim()) renderSearchResults();
    });

    searchInput.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        if (!searchPanel.hidden) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch(false, true);
        }
        return;
      }
      if (event.key === 'ArrowDown' && !searchPanel.hidden) {
        const first = resultLinks()[0];
        if (first) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === 'ArrowUp' && !searchPanel.hidden) {
        const links = resultLinks();
        const last = links.at(-1);
        if (last) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (event.key === 'Enter' && !searchPanel.hidden) {
        const first = resultLinks()[0];
        if (first) {
          event.preventDefault();
          first.click();
        }
      }
    });

    searchResults.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSearch(false, true);
        return;
      }
      const links = resultLinks();
      const current = links.indexOf(document.activeElement);
      if (current < 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        links[Math.min(current + 1, links.length - 1)].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        links[Math.max(current - 1, 0)].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        links[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        links[links.length - 1].focus();
      }
    });

    searchWrap.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing || searchPanel.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      closeSearch(false, true);
    });

    if (searchClear) {
      searchClear.addEventListener('mousedown', (event) => event.preventDefault());
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        updateSearchChrome();
        closeSearch(false, true);
      });
    }

    document.addEventListener('pointerdown', (event) => {
      if (searchPanel.hidden) return;
      if (event.target instanceof Node && searchWrap.contains(event.target)) return;
      closeSearch(false, false);
    });

    // Global shortcuts: focus search, close search, close the mobile drawer.
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (
        modifier &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key.toLowerCase() === 'k' || event.code === 'KeyK')
      ) {
        event.preventDefault();
        const focusSearch = () => {
          searchInput.focus();
          searchInput.select();
          if (searchQuery.trim()) renderSearchResults();
        };
        if (mobileQuery.matches && !app.classList.contains('docs-nav-open')) {
          setNavOpen(true, { focus: false });
          window.requestAnimationFrame(focusSearch);
        } else {
          focusSearch();
        }
        return;
      }
      if (event.key === 'Escape') {
        if (!searchPanel.hidden) {
          event.preventDefault();
          closeSearch(false, true);
          return;
        }
        if (app.classList.contains('docs-nav-open')) {
          event.preventDefault();
          setNavOpen(false, { restoreFocus: true });
        }
      }
    });

    // Same-page links become docs routes; external links are untouched.
    document.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!target || !shell.contains(target)) return;
      if (target.hasAttribute('data-docs-top')) {
        event.preventDefault();
        resetScroll();
        return;
      }
      const href = target.getAttribute('href');
      if (!href || !href.startsWith('#')) return;
      event.preventDefault();
      const fromResult = target.closest('.docs-result');
      if (fromResult) closeSearch(true, false);
      else if (!searchPanel.hidden) closeSearch(false, false);
      if (app.classList.contains('docs-nav-open')) {
        setNavOpen(false, { restoreFocus: false });
      }
      navigate(href, { focus: true });
    });

    // Collapsible groups.
    for (const toggle of groupToggles) {
      toggle.addEventListener('click', () => {
        setGroupOpen(toggle, toggle.getAttribute('aria-expanded') !== 'true');
      });
    }

    // Mobile drawer.
    if (navToggle) {
      navToggle.addEventListener('click', () => {
        setNavOpen(!app.classList.contains('docs-nav-open'));
      });
    }
    if (navClose) {
      navClose.addEventListener('click', () => {
        setNavOpen(false, { restoreFocus: true });
      });
    }
    if (scrim) {
      scrim.addEventListener('click', () => setNavOpen(false, { restoreFocus: true }));
    }
    mobileQuery.addEventListener('change', (event) => {
      if (!event.matches) setNavOpen(false, { restoreFocus: false });
    });

    // Keep Tab inside the open drawer instead of reaching the inert document behind it.
    sidebar.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || !mobileQuery.matches) return;
      if (!app.classList.contains('docs-nav-open')) return;
      const focusable = Array.from(
        sidebar.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(
        (element) =>
          element.offsetParent !== null &&
          !element.closest('[hidden]') &&
          !element.hasAttribute('hidden')
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    // Hash / history routing.
    window.addEventListener('hashchange', () => route({ focus: true }));
    window.addEventListener('popstate', () => route({ focus: true }));

    // site.js owns data-locale; docs only follows it.
    const localeObserver = new MutationObserver(() => {
      const next = root.dataset.locale === 'en' ? 'en' : 'zh';
      if (next === locale) return;
      locale = next;
      cachedIndex = null;
      refreshLocaleTexts();
    });
    localeObserver.observe(root, { attributes: true, attributeFilter: ['data-locale'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
