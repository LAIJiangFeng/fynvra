import { legacyDocsTargets } from './legacy-docs';

// Shared inline browser code: the static docs.html endpoint has no Astro script bundling.
// This code is only used by compatibility entries, never by localized content pages.
const localeSelection = `
  function selectLocale() {
    var explicit = window.location.pathname.match(/^\\/(zh|en)(?:\\/|$)/);
    if (explicit) return explicit[1];
    var query = new URLSearchParams(window.location.search).get('lang');
    if (query === 'zh' || query === 'en') return query;
    try {
      var stored = window.localStorage.getItem('fynvra-site-locale');
      if (stored === 'zh' || stored === 'en') return stored;
    } catch (_) {}
    var languages = navigator.languages || [navigator.language];
    for (var language of languages) {
      var base = String(language).toLowerCase().split('-')[0];
      if (base === 'zh' || base === 'en') return base;
    }
    return 'zh';
  }
  var locale = selectLocale();
  try { window.localStorage.setItem('fynvra-site-locale', locale); } catch (_) {}
`;

export function entryRedirectScript(destination: 'home' | 'docs'): string {
  const redirect = destination === 'home'
    ? `window.location.replace('/' + locale + '/' + window.location.hash);`
    : `
      var targets = ${JSON.stringify(legacyDocsTargets)};
      var anchor = '';
      try { anchor = decodeURIComponent(window.location.hash.slice(1)); } catch (_) {}
      var path = Object.prototype.hasOwnProperty.call(targets, anchor)
        ? targets[anchor]
        : 'docs/overview/';
      window.location.replace('/' + locale + '/' + path);
    `;
  return `(function () {\n${localeSelection}\n${redirect}\n})();`;
}
