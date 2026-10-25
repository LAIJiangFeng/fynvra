// 导入弹窗与「拉取模型列表」面板底部告警的界面写法（纯函数，在 node 下测试）。
// 告警是 Main 给的整句：列表里一行一条，只留「来源 · 名称：原因」，整句放在悬停提示里。

/** 不超过这么多条时逐行列出；更多时折叠成「N 条提示」，默认收起 */
export const INLINE_WARNING_LIMIT = 2;

/**
 * 句末的后续动作与建议（Main 的告警用「，」接在原因后面，英文用「; 」）：已跳过、已忽略其中的 key、已改用 …、
 * 导入后需要在编辑里补上、fynvra 不会展开 …、这里只列出了第一页（英文 skipped / ignored … / using … /
 * fill it in / set the API key / fynvra won't … / only the first page）。只认这几种开头，原因里的逗号不受影响。
 */
const FOLLOW_UP =
  /(?:，(?:已跳过|已忽略|已改用|导入后|fynvra 不会展开|这里只列出)|; (?:skipped|ignored|using |fill it in|set the API key|fynvra won't|only the first page)).*$/u;

/** 告警的一行写法：去掉句末的后续动作与建议；没有可去的原样返回，也不会去成空串 */
export function warningLine(warning: string): string {
  return warning.replace(FOLLOW_UP, '') || warning;
}
