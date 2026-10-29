// Snapshot of every article/body id in the original website/docs.html.
// Keep these aliases when editing migrated content, including the demo scene ids.
const legacyArticleAnchors: Record<string, readonly string[]> = {
  overview: ['overview-layout', 'overview-objects', 'overview-start'],
  install: ['install-download', 'install-macos', 'install-source', 'install-check'],
  quickstart: [
    'quickstart-provider', 'quickstart-workspace', 'quickstart-session',
    'quickstart-first', 'quickstart-review', 'quickstart-examples',
    'quickstart-example-dispatch', 'fd-scene-collab',
    'quickstart-example-models', 'fd-scene-model',
    'quickstart-example-role', 'fd-scene-roles',
  ],
  workspace: ['workspace-add', 'workspace-sessions', 'workspace-actions', 'workspace-worktrees'],
  sessions: ['sessions-create', 'sessions-switch', 'sessions-status', 'sessions-worker', 'sessions-manage'],
  composer: ['composer-send', 'composer-model', 'composer-approval', 'composer-images'],
  panels: ['panels-layout', 'panels-files', 'panels-changes'],
  orchestration: ['orchestration-loop', 'orchestration-conditions', 'orchestration-control'],
  tasks: ['tasks-view', 'tasks-detail', 'tasks-output', 'tasks-review'],
  approval: ['approval-set', 'approval-modes', 'approval-respond', 'approval-floor'],
  providers: ['providers-add', 'providers-test', 'providers-import', 'providers-keys'],
  thinking: ['thinking-set', 'thinking-levels', 'thinking-source'],
  roles: ['roles-edit', 'roles-builtin', 'roles-policy'],
  skills: ['skills-register', 'skills-manage', 'skills-notes'],
  mcp: ['mcp-add', 'mcp-import', 'mcp-manage'],
  instructions: ['instructions-add', 'instructions-activate', 'instructions-limits'],
  appearance: [
    'appearance-theme', 'appearance-language', 'appearance-general',
    'appearance-notifications', 'appearance-usage',
  ],
  shortcuts: ['shortcuts-app', 'shortcuts-rebind', 'shortcuts-docs'],
  data: ['data-location', 'data-boundary', 'data-update'],
  faq: ['faq-price', 'faq-without-git', 'faq-platforms'],
};

// All values are fixed same-site path suffixes, never a visitor-supplied URL.
export const legacyDocsTargets: Record<string, string> = Object.fromEntries(
  Object.entries(legacyArticleAnchors).flatMap(([article, anchors]) => [
    [article, `docs/${article}/`],
    ...anchors.map((anchor) => [anchor, `docs/${article}/#${encodeURIComponent(anchor)}`]),
  ]),
);
