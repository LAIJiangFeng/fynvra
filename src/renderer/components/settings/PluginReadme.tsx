import { type PluginReadmeResult, type ReadmeSource, readmeSourceKey } from '@shared/types/plugins';
import { Loader2 } from 'lucide-react';
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { type Components, defaultUrlTransform, type UrlTransform } from 'react-markdown';
import { Markdown } from '@/components/chat/Markdown';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '@/i18n/I18nProvider';
import { useAppPluginsStore } from '@/stores/appPlugins';
import { usePluginsStore } from '@/stores/plugins';
import { InlineMessage } from './common';

const isHttp = (url: unknown): url is string =>
  typeof url === 'string' && /^https?:\/\//i.test(url);

const LINK_CLASS = 'font-medium text-primary underline underline-offset-4';

/** CSP 允许的 data: 图片（只认这四种位图） */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
/** 同一份 README 最多加载的图片数、同时进行的请求数、缓存条数 */
export const MAX_README_IMAGES = 40;
const MAX_CONCURRENT = 4;
const MAX_CACHED = 100;

/** src 怎么处理：data 直接显示，remote / local 交给 Main，其余当作加载失败 */
export function classifyImageSrc(
  src: string,
  source: ReadmeSource
): 'data' | 'remote' | 'local' | 'none' {
  if (DATA_IMAGE.test(src)) return 'data';
  if (/^https:\/\//i.test(src)) return 'remote';
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || /^[/\\~]/.test(src)) return 'none';
  return source.kind === 'market' ? 'none' : 'local';
}

/** 结果按「source + src」缓存（失败为 null），翻页回来不用重新请求 */
const imageCache = new Map<string, Promise<string | null>>();
const settled = new Map<string, string | null>();
let active = 0;
const waiting: (() => void)[] = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function loadImage(source: ReadmeSource, src: string): Promise<string | null> {
  const key = `${readmeSourceKey(source)}\u0000${src}`;
  let pending = imageCache.get(key);
  if (!pending) {
    if (imageCache.size >= MAX_CACHED) {
      const oldest = imageCache.keys().next().value;
      if (oldest !== undefined) {
        imageCache.delete(oldest);
        settled.delete(oldest);
      }
    }
    pending = limited(() => usePluginsStore.getState().readmeImage(source, src)).then((result) => {
      const value = result.ok ? result.dataUrl : null;
      if (imageCache.has(key)) settled.set(key, value);
      return value;
    });
    imageCache.set(key, pending);
  }
  return pending;
}

function dimension(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 4096 ? parsed : undefined;
}

/** img 的 align：left / right 浮动，top / middle / bottom 是垂直对齐 */
function imageAlign(value: unknown): CSSProperties | undefined {
  if (value === 'left') return { float: 'left', marginRight: '0.5rem' };
  if (value === 'right') return { float: 'right', marginLeft: '0.5rem' };
  if (value === 'top' || value === 'middle' || value === 'bottom') return { verticalAlign: value };
  return undefined;
}

/** 图片已在链接里时，失败标签不再套一层链接 */
const InLink = createContext(false);

function ReadmeImage({
  source,
  src,
  alt,
  width,
  height,
  align,
  allowed,
}: {
  source: ReadmeSource;
  src: string;
  alt: string;
  width?: number;
  height?: number;
  align: CSSProperties | undefined;
  allowed: boolean;
}) {
  const t = useT();
  const inLink = useContext(InLink);
  const kind = classifyImageSrc(src, source);
  const loadable = allowed && (kind === 'remote' || kind === 'local');
  const key = `${readmeSourceKey(source)}\u0000${src}`;
  const [loaded, setLoaded] = useState<{ key: string; value: string | null } | null>(null);
  useEffect(() => {
    if (!loadable || settled.has(key)) return;
    let current = true;
    void loadImage(source, src).then((value) => {
      if (current) setLoaded({ key, value });
    });
    return () => {
      current = false;
    };
  }, [loadable, key, source, src]);

  const dataUrl =
    kind === 'data'
      ? src
      : !loadable
        ? null
        : settled.has(key)
          ? settled.get(key)
          : loaded?.key === key
            ? loaded.value
            : undefined;

  if (dataUrl === undefined) {
    // 加载中：有尺寸就占同样大的位置，没有就显示小号 alt 文字，布局不跳动
    return width || height ? (
      <span
        role="img"
        aria-label={alt}
        className="inline-block max-w-full animate-pulse rounded bg-muted align-middle"
        style={{ width: width ?? height, height: height ?? width, ...align }}
      />
    ) : (
      <span className="text-muted-foreground text-xs">{alt}</span>
    );
  }
  if (dataUrl === null) {
    const label = (
      <span
        style={align}
        className="inline-block rounded bg-muted px-1.5 py-0.5 align-middle text-muted-foreground text-xs"
      >
        {alt || t('settings.plugins.readme.image')}
      </span>
    );
    return isHttp(src) && !inLink ? (
      <a href={src} target="_blank" rel="noreferrer">
        {label}
      </a>
    ) : (
      label
    );
  }
  return (
    <img
      src={dataUrl}
      alt={alt}
      width={width}
      height={height}
      style={align}
      className="inline h-auto max-w-full"
    />
  );
}

/** 只放行 CSP 允许的 data: 图片，其余按 react-markdown 默认规则 */
const readmeUrlTransform: UrlTransform = (url, key) =>
  key === 'src' && DATA_IMAGE.test(url) ? url : defaultUrlTransform(url);

/**
 * README 渲染（市场详情与已装插件共用）。内嵌 HTML 按 GitHub 规则过滤后渲染；
 * 图片：data:（四种位图）直接显示，https 与插件目录里的相对路径由 Main 转成 data URL，其余显示 alt 标签；
 * 链接只有 http(s) 可点（target=_blank 由 Main 交给系统浏览器），相对链接和其他协议只显示文字。
 */
export function ReadmeView({ text, source }: { text: string; source: ReadmeSource }) {
  const sourceKey = readmeSourceKey(source);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按 source 的键与正文重建，source 对象每次渲染可能是新的
  const components = useMemo<Components>(() => {
    // 本份 README 已分配名额的地址；超过 40 张的按加载失败处理
    const budget = new Set<string>();
    return {
      img: ({ src, alt, width, height, node }) => {
        const url = typeof src === 'string' ? src : '';
        const kind = classifyImageSrc(url, source);
        if ((kind === 'remote' || kind === 'local') && budget.size < MAX_README_IMAGES) {
          budget.add(url);
        }
        return (
          <ReadmeImage
            source={source}
            src={url}
            alt={alt ?? ''}
            width={dimension(width)}
            height={dimension(height)}
            align={imageAlign(node?.properties.align)}
            allowed={budget.has(url)}
          />
        );
      },
      a: ({ href, children }) =>
        isHttp(href) ? (
          <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
            <InLink.Provider value={true}>{children}</InLink.Provider>
          </a>
        ) : (
          <span>{children}</span>
        ),
    };
  }, [sourceKey, text]);
  return (
    <div className="rounded-lg border px-4 py-3">
      <Markdown text={text} html components={components} urlTransform={readmeUrlTransform} />
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
  if ('text' in loaded) return <ReadmeView text={loaded.text} source={{ kind, id }} />;
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
