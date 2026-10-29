export type Locale = 'zh' | 'en';

export const homeCopy = {
  zh: {
    title: 'Fynvra — 本地多 Agent AI 编程工作台',
    description:
      'Fynvra 是开源的本地桌面 AI 编程工作台：主 Agent 拆分需求，派发到独立的 git worktree，再审查、检查并合并。',
    ogDescription: '只和一个 Agent 对话，让一支团队并行交付。',
    skipLink: '跳到正文',
  },
  en: {
    title: 'Fynvra — The local multi-agent AI coding workbench',
    description:
      'An open-source desktop AI coding workbench with built-in multi-agent orchestration.',
    ogDescription: 'Talk to one agent. A whole team ships.',
    skipLink: 'Skip to content',
  },
} satisfies Record<Locale, {
  title: string;
  description: string;
  ogDescription: string;
  skipLink: string;
}>;
