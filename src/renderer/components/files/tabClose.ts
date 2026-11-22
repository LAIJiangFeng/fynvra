export type TabCloseAction = 'close' | 'others' | 'left' | 'right';

/** 按界面显示顺序算出要关闭的标签 key；「对话」标签（chat）永远不关。 */
export function tabsToClose(
  orderedKeys: readonly string[],
  tabKey: string,
  action: TabCloseAction
): string[] {
  const index = orderedKeys.indexOf(tabKey);
  if (index < 0) return [];
  const picked =
    action === 'close'
      ? [tabKey]
      : action === 'others'
        ? orderedKeys.filter((key) => key !== tabKey)
        : action === 'left'
          ? orderedKeys.slice(0, index)
          : orderedKeys.slice(index + 1);
  return picked.filter((key) => key !== 'chat');
}
