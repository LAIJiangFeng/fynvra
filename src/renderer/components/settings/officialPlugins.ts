import { type LucideIcon, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MessageId } from '../../i18n';
import type { SettingsSection } from './settingsViewStore';

/**
 * 官方插件：随应用发布的可选功能，默认不启用；启用后设置侧边栏才出现同名入口。
 * 只是界面层入口，启用状态以各自 Main 服务的数据为准（Telegram 即 telegram.json 的 enabled）。
 * 以后加新的官方插件在这里追加一项。
 */
export interface OfficialPlugin {
  /** 同时是设置侧边栏的分组 id */
  id: SettingsSection;
  icon: LucideIcon;
  nameKey: MessageId;
  descriptionKey: MessageId;
}

export const OFFICIAL_PLUGINS: readonly OfficialPlugin[] = [
  {
    id: 'telegram',
    icon: Send,
    nameKey: 'settings.plugins.official.telegram.name',
    descriptionKey: 'settings.plugins.official.telegram.description',
  },
];

const OFFICIAL_IDS = new Set<string>(OFFICIAL_PLUGINS.map((plugin) => plugin.id));

/** 侧边栏条目过滤：官方插件的入口只在已启用时保留，其他条目原样保留 */
export function visibleSections<T extends { value: SettingsSection }>(
  sections: readonly T[],
  enabled: ReadonlySet<SettingsSection>
): T[] {
  return sections.filter((item) => !OFFICIAL_IDS.has(item.value) || enabled.has(item.value));
}

/**
 * Telegram 是否已启用：挂载时读一次 getState，再随 telegram:changed 刷新。
 * null 表示还在读取；读取失败按未启用处理。过期响应丢弃。
 */
export function useTelegramEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    const api = window.fynvra.telegram;
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      let next = false;
      try {
        const result = await api.getState();
        next = result.ok && result.state.enabled;
      } catch {
        next = false;
      }
      if (mine === seq) setEnabled(next);
    };
    void load();
    const off = api.onChanged(() => void load());
    return () => {
      off();
      seq += 1;
    };
  }, []);
  return enabled;
}
