/**
 * 每个 attempt 的全新 Fynvra 预置的数据：临时 userData 里的 settings.json，
 * 加一个只含一个文本文件的工作区目录。测试按这些值定位界面，所以集中放在这里。
 */
export interface Seed {
  /** 写进 settings.json 的界面语言；固定下来，文本定位不随本机系统语言变化。 */
  readonly language: 'zh-CN' | 'en';
  readonly workspace: { readonly id: string; readonly name: string };
  readonly file: { readonly name: string; readonly content: string };
}

export const SEED: Seed = {
  language: 'zh-CN',
  workspace: { id: 'e2e-workspace', name: 'E2E 工作区' },
  file: { name: 'notes.txt', content: 'Fynvra E2E 预置文件内容' },
};
