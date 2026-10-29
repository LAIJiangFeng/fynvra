// Shared by the visible prompt blocks and demo messages; home.js types the rendered code text.
export type DemoLocale = "zh" | "en";

export const prompts = {
  "collab": {
    "zh": "这个仓库里有两个互不相关的任务，请分别派给两个 Worker 并行做：\n1. 优化首页排版，统一间距和字号，不改文案；\n2. 整理使用文档，补上缺失的操作步骤。\n都做完后由你审查并合并；有拿不准的地方先来问我。",
    "en": "The repo has two unrelated tasks. Dispatch each to a separate worker and run them in parallel:\n1. Tighten the home page layout — consistent spacing and type sizes, no copy changes.\n2. Rework the user docs and fill in the missing steps.\nReview and merge both when they finish; ask me first if anything is unclear."
  },
  "model": {
    "zh": "分派两个任务：\n- 首页实现交给一个 Worker，用 DeepSeek 的 deepseek-chat；\n- 文档整理交给另一个 Worker，用 GPT 的 gpt-5.5。\n两个任务都完成后由你审查合并。如果其中某个模型没配置好，直接告诉我，不要换别的模型顶替。",
    "en": "Dispatch two tasks:\n- Home page implementation goes to one worker on DeepSeek deepseek-chat.\n- Docs cleanup goes to another worker on GPT gpt-5.5.\nReview and merge both when they finish. If one of those models is not configured, tell me instead of substituting another one."
  },
  "role-worker": {
    "zh": "为设置页增加侧栏折叠：折叠后只保留图标，状态记在本地，并说明你改了哪些文件。",
    "en": "Add a collapsible sidebar to the settings page: when collapsed only icons remain, remember the state locally, and list the files you changed."
  },
  "role-review": {
    "zh": "检查刚才的侧栏折叠实现：键盘操作、折叠状态持久化和布局是否符合预期，只列出问题和改进建议，不要修改文件，也不要提交。",
    "en": "Review the sidebar-collapse implementation you just made: keyboard operation, persisted collapse state, and layout. List only problems and suggestions; do not edit files and do not commit."
  }
} as const;

export type DemoPromptName = keyof typeof prompts;

export const promptLabels = {
  "collab": {
    "zh": "提示词",
    "en": "prompt"
  },
  "model": {
    "zh": "提示词",
    "en": "prompt"
  },
  "role-worker": {
    "zh": "提示词 · Worker 会话",
    "en": "prompt · Worker session"
  },
  "role-review": {
    "zh": "提示词 · 代码审查员会话",
    "en": "prompt · Code reviewer session"
  }
} as const;
