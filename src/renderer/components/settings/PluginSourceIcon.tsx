import { BadgeCheck, GitBranch, Laptop, type LucideIcon, Store, UserRound } from 'lucide-react';
import github from '@/assets/plugin-icons/github.svg';
import gitlab from '@/assets/plugin-icons/gitlab.svg';
import npm from '@/assets/plugin-icons/npm.svg';
import { cn } from '@/lib/utils';
import type { PluginSourceIconKind } from './pluginSource';

const BRAND_ICONS: Partial<Record<PluginSourceIconKind, string>> = { github, gitlab, npm };
const LUCIDE_ICONS: Partial<Record<PluginSourceIconKind, LucideIcon>> = {
  official: BadgeCheck,
  person: UserRound,
  local: Laptop,
  git: GitBranch,
  market: Store,
};

/** 作者位的来源图标；品牌 SVG 用 mask 渲染，颜色跟随文字。旁边有名字，读屏跳过图标 */
export function PluginSourceIcon({ kind }: { kind: PluginSourceIconKind }) {
  const brand = BRAND_ICONS[kind];
  if (brand) {
    return (
      <span
        aria-hidden
        className="size-4 shrink-0 bg-current"
        style={{
          maskImage: `url("${brand}")`,
          maskSize: 'contain',
          maskPosition: 'center',
          maskRepeat: 'no-repeat',
        }}
      />
    );
  }
  const Icon = LUCIDE_ICONS[kind] ?? Store;
  return (
    <Icon aria-hidden className={cn('size-4 shrink-0', kind === 'official' && 'text-primary')} />
  );
}
