import type { PluginReadmeResult } from '@shared/types/plugins';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Components } from 'react-markdown';
import { Markdown } from '@/components/chat/Markdown';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '@/i18n/I18nProvider';
import { useAppPluginsStore } from '@/stores/appPlugins';
import { usePluginsStore } from '@/stores/plugins';
import { InlineMessage } from './common';

const isHttp = (url: unknown): url is string =>
  typeof url === 'string' && /^https?:\/\//i.test(url);

const LINK_CLASS = 'font-medium text-primary underline underline-offset-4';

/**
 * README 渲染（市场详情与已装插件共用）。图片一律不加载，换成「[图片：alt]」文字，http(s) 地址可点开；
 * 链接只有 http(s) 可点（target=_blank 由 Main 交给系统浏览器），相对链接和其他协议只显示文字；原始 HTML 不渲染。
 */
export function ReadmeView({ text }: { text: string }) {
  const t = useT();
  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt }) => {
        const label = t('settings.plugins.market.image', {
          alt: alt || (typeof src === 'string' ? src : ''),
        });
        return isHttp(src) ? (
          <a href={src} target="_blank" rel="noreferrer" className={LINK_CLASS}>
            {label}
          </a>
        ) : (
          <span>{label}</span>
        );
      },
      a: ({ href, children }) =>
        isHttp(href) ? (
          <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
            {children}
          </a>
        ) : (
          <span>{children}</span>
        ),
    }),
    [t]
  );
  return (
    <div className="rounded-lg border px-4 py-3">
      <Markdown text={text} components={components} />
    </div>
  );
}

export function ReadmeLoading() {
  const t = useT();
  return (
    <p className="flex items-center gap-2 text-muted-foreground text-sm">
      <Loader2 className="size-4 animate-spin" />
      {t('settings.plugins.readme.loading')}
    </p>
  );
}

type Loaded = { text: string } | { none: true } | { error: string };

/**
 * 已装插件的「使用说明」：读插件目录里的 README.md。没有时先试 fallback（市场里该版本的 README），
 * 仍没有就显示一行简介和「没有提供使用说明」。
 */
export function InstalledReadme({
  kind,
  id,
  description,
  fallback,
}: {
  kind: 'fynvra' | 'pi';
  id: string;
  description?: string;
  fallback?: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}) {
  const t = useT();
  const readFynvra = useAppPluginsStore((state) => state.readme);
  const readPi = usePluginsStore((state) => state.readme);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fallback 每次渲染都是新函数，只按插件重新加载
  useEffect(() => {
    let active = true;
    setLoaded(null);
    const load = async (): Promise<Loaded> => {
      const result: PluginReadmeResult = await (kind === 'fynvra' ? readFynvra : readPi)(id);
      if (result.ok) return { text: result.text };
      if (result.code === 'too-large') return { error: t('settings.plugins.readme.tooLarge') };
      if (result.code !== 'none') {
        return { error: t('settings.plugins.readme.failed', { error: result.error }) };
      }
      const market = fallback ? await fallback() : null;
      return market?.ok ? { text: market.text } : { none: true };
    };
    void load().then((next) => {
      if (active) setLoaded(next);
    });
    return () => {
      active = false;
    };
  }, [kind, id, readFynvra, readPi, t]);

  if (!loaded) return <ReadmeLoading />;
  if ('text' in loaded) return <ReadmeView text={loaded.text} />;
  if ('error' in loaded) {
    return (
      <InlineMessage tone="error" className="break-all">
        {loaded.error}
      </InlineMessage>
    );
  }
  return (
    <div className="grid gap-2 text-sm">
      {description && <p>{description}</p>}
      <p className="text-muted-foreground">{t('settings.plugins.readme.none')}</p>
    </div>
  );
}

type DetailTab = 'readme' | 'settings';

/** 本次运行里每个插件上次选的标签（不持久化）；键为 `${kind}:${id}` */
const lastTabs = new Map<string, DetailTab>();

/**
 * 插件详情页下半部分：「使用说明」「设置」两个标签；默认打开本次运行上次选的标签（没有时为使用说明）。
 * settingsRequest 每次增大（从「…」菜单选「设置」/「添加服务名」）都切到设置标签；0 表示没有请求
 */
export function PluginDetailTabs({
  tabKey,
  settingsRequest = 0,
  readme,
  settings,
}: {
  tabKey: string;
  settingsRequest?: number;
  readme: ReactNode;
  settings: ReactNode;
}) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>(() =>
    settingsRequest > 0 ? 'settings' : (lastTabs.get(tabKey) ?? 'readme')
  );
  useEffect(() => {
    lastTabs.set(tabKey, tab);
  }, [tabKey, tab]);
  useEffect(() => {
    if (settingsRequest > 0) setTab('settings');
  }, [settingsRequest]);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === 'readme' || value === 'settings') setTab(value);
      }}
      className="gap-4"
    >
      <TabsList>
        <TabsTrigger value="readme" className="px-3">
          {t('settings.plugins.detailTabs.readme')}
        </TabsTrigger>
        <TabsTrigger value="settings" className="px-3">
          {t('settings.plugins.detailTabs.settings')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="readme">{readme}</TabsContent>
      <TabsContent value="settings">{settings}</TabsContent>
    </Tabs>
  );
}
