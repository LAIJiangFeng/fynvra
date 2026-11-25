import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PluginSourceIcon } from './PluginSourceIcon';
import type { PluginSourceIconKind } from './pluginSource';

/** 插件卡片网格：宽屏三列，窄屏自动两列、一列（「已安装」与「市场」共用） */
export function PluginGrid({ children }: { children: ReactNode }) {
  return (
    <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
      {children}
    </ul>
  );
}

/** 卡片底部左侧的作者：来源图标 + 名字，可带小号附注（版本号等） */
export function PluginAuthor({
  icon,
  name,
  note,
}: {
  icon: PluginSourceIconKind;
  name: string;
  note?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <PluginSourceIcon kind={icon} />
      <span className="truncate">{name}</span>
      {note && <span className="shrink-0 opacity-80">{note}</span>}
    </span>
  );
}

export interface PluginFaceProps {
  icon: LucideIcon;
  /** 品牌图标地址（彩色原图），有则代替 icon 显示 */
  logo?: string;
  name: string;
  badges?: ReactNode;
  description: ReactNode;
  extra?: ReactNode;
  author: ReactNode;
  actions?: ReactNode;
}

/**
 * 详情页的标题区：与卡片用同一组属性（图标、名字、徽标、作者与版本、简介、附加区），
 * 操作（更新、开关、「…」菜单）放右侧
 */
export function PluginHeader({
  icon: Icon,
  logo,
  name,
  badges,
  description,
  extra,
  author,
  actions,
}: PluginFaceProps) {
  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg border bg-muted">
          {logo ? (
            <img src={logo} alt="" aria-hidden draggable={false} className="size-6" />
          ) : (
            <Icon className="size-5 text-muted-foreground" />
          )}
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="font-medium">{name}</h3>
            {badges}
          </div>
          {author}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{actions}</div>}
      </div>
      <div className="text-muted-foreground text-sm">{description}</div>
      {extra && <div className="grid min-w-0 gap-2">{extra}</div>}
    </div>
  );
}

/**
 * 通用插件卡片（只负责展示）：图标 + 名字 + 徽标、两行简介、附加区、分隔线和底部（作者 / 操作）。
 * 传了 onOpen 时整张卡可点：用一个铺满卡片的透明 button 实现（不把开关、菜单嵌进 button 里），
 * 底部操作区叠在它上面并阻止冒泡，不会误触打开。
 */
export function PluginCard({
  icon: Icon,
  logo,
  name,
  badges,
  description,
  extra,
  author,
  actions,
  onOpen,
}: PluginFaceProps & { onOpen?: () => void }) {
  return (
    <li
      className={cn(
        'relative flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 transition-colors',
        onOpen && 'hover:bg-accent/40'
      )}
    >
      {onOpen && (
        <button
          type="button"
          aria-label={name}
          // 透明按钮盖住了内层元素，title 放这里才看得到：简介被两行截断时悬停看全文
          title={typeof description === 'string' ? description : name}
          className="absolute inset-0 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={onOpen}
        />
      )}
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted">
          {logo ? (
            <img src={logo} alt="" aria-hidden draggable={false} className="size-5" />
          ) : (
            <Icon className="size-4.5 text-muted-foreground" />
          )}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-sm" title={name}>
            {name}
          </span>
          {badges}
        </div>
      </div>
      <div className="line-clamp-2 min-h-10 text-muted-foreground text-sm">{description}</div>
      {extra && <div className="min-w-0">{extra}</div>}
      <div className="mt-auto flex min-h-8 items-center justify-between gap-2 border-t pt-3">
        <div className="min-w-0 flex-1">{author}</div>
        {actions && (
          // 叠在铺满卡片的 button 之上；阻止冒泡，开关、按钮、菜单不触发打开
          // biome-ignore lint/a11y/noStaticElementInteractions: 只拦截冒泡，不是交互元素
          // biome-ignore lint/a11y/useKeyWithClickEvents: 同上
          <div
            className="relative z-10 flex shrink-0 items-center gap-1.5"
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        )}
      </div>
    </li>
  );
}
