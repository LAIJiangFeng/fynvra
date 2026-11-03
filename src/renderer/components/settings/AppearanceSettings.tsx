import {
  isTerminalColorSchemeId,
  TERMINAL_COLOR_SCHEMES,
  type TerminalColorScheme,
  type TerminalColorSchemeId,
  terminalColorSchemeOf,
} from '@shared/terminalColorSchemes';
import {
  type AppearancePreferences,
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_TERMINAL_FONT_FAMILY,
  FONT_WEIGHTS,
  type FontWeight,
  isFontWeight,
  parseFontFamily,
  TERMINAL_FONT_SIZE_RANGE,
  type ThemeMode,
  UI_FONT_SIZE_RANGE,
} from '@shared/types/settings';
import { type LucideIcon, Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { type ComponentProps, type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MessageId } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { DEFAULT_UI_FONT_FAMILY } from '@/lib/appearance';
import { cn } from '@/lib/utils';
import { useAppearanceStore, useSettingsStore } from '@/stores/settings';
import { InlineMessage, SectionHeader } from './common';

const THEMES: { value: ThemeMode; icon: LucideIcon }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

type AppearanceKey = keyof AppearancePreferences;

const UI_KEYS: readonly AppearanceKey[] = ['uiFontFamily', 'uiFontSize', 'uiFontWeight'];
const TERMINAL_KEYS: readonly AppearanceKey[] = [
  'terminalColorScheme',
  'terminalFontFamily',
  'terminalFontSize',
  'terminalFontWeight',
  'terminalFontWeightBold',
];

const WEIGHT_LABELS: Record<FontWeight, MessageId> = {
  '100': 'settings.appearance.weights.thin',
  '200': 'settings.appearance.weights.extraLight',
  '300': 'settings.appearance.weights.light',
  normal: 'settings.appearance.weights.normal',
  '500': 'settings.appearance.weights.medium',
  '600': 'settings.appearance.weights.semiBold',
  bold: 'settings.appearance.weights.bold',
  '800': 'settings.appearance.weights.extraBold',
  '900': 'settings.appearance.weights.black',
};

/** 色块里排的颜色：前景色与几种 ANSI 色，底色是方案的背景色 */
const SWATCH_COLORS = ['foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

const SCHEME_ITEMS = TERMINAL_COLOR_SCHEMES.map((scheme) => ({
  value: scheme.id,
  label: scheme.name,
}));

function isDefault(appearance: AppearancePreferences, keys: readonly AppearanceKey[]): boolean {
  return keys.every((key) => appearance[key] === DEFAULT_APPEARANCE_PREFERENCES[key]);
}

/** 恢复默认：这几项都给 undefined，Main 删掉对应字段 */
function resetPatch(keys: readonly AppearanceKey[]): Partial<AppearancePreferences> {
  return Object.fromEntries(keys.map((key) => [key, undefined]));
}

/**
 * 外观：主题与标题栏的主题菜单共用 settings store，两处始终一致；
 * 界面与终端的字体设置即时生效（useAppearanceStore）。
 */
export function AppearanceSettings() {
  const error = useAppearanceStore((state) => state.error);
  return (
    <div className="grid gap-8">
      <ThemeSection />
      <InterfaceSection />
      <TerminalSection />
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </div>
  );
}

function ThemeSection() {
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const t = useT();

  return (
    <section>
      <SectionHeader title={t('settings.appearance.theme')} />
      <div className="grid grid-cols-3 gap-3">
        {THEMES.map(({ value, icon: Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={theme === value}
            onClick={() => setTheme(value)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border p-4 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
              theme === value && 'border-primary bg-accent font-medium'
            )}
          >
            <Icon className="size-5" />
            {t(`app.themes.${value}`)}
          </button>
        ))}
      </div>
    </section>
  );
}

function InterfaceSection() {
  const appearance = useAppearanceStore((state) => state.appearance);
  const update = useAppearanceStore((state) => state.update);
  const t = useT();
  return (
    <section>
      <SectionHeader title={t('settings.appearance.interface')}>
        <ResetButton
          disabled={isDefault(appearance, UI_KEYS)}
          onClick={() => void update(resetPatch(UI_KEYS))}
        />
      </SectionHeader>
      <ul className="divide-y rounded-lg border">
        <SettingRow
          label={t('settings.appearance.font')}
          hint={t('settings.appearance.uiFontHint')}
        >
          {(id) => (
            <FontFamilyInput
              id={id}
              value={appearance.uiFontFamily}
              placeholder={DEFAULT_UI_FONT_FAMILY}
              onCommit={(uiFontFamily) => void update({ uiFontFamily })}
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.appearance.fontSize')}
          hint={t('settings.appearance.uiFontSizeHint', UI_FONT_SIZE_RANGE)}
        >
          {(id) => (
            <FontSizeInput
              id={id}
              value={appearance.uiFontSize}
              range={UI_FONT_SIZE_RANGE}
              onCommit={(uiFontSize) => void update({ uiFontSize })}
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.appearance.fontWeight')}
          hint={t('settings.appearance.uiFontWeightHint')}
        >
          {(id) => (
            <FontWeightSelect
              id={id}
              value={appearance.uiFontWeight}
              onChange={(uiFontWeight) => void update({ uiFontWeight })}
            />
          )}
        </SettingRow>
      </ul>
    </section>
  );
}

function TerminalSection() {
  const appearance = useAppearanceStore((state) => state.appearance);
  const update = useAppearanceStore((state) => state.update);
  const t = useT();
  return (
    <section>
      <SectionHeader title={t('settings.appearance.terminal')}>
        <ResetButton
          disabled={isDefault(appearance, TERMINAL_KEYS)}
          onClick={() => void update(resetPatch(TERMINAL_KEYS))}
        />
      </SectionHeader>
      <ul className="divide-y rounded-lg border">
        <SettingRow label={t('settings.appearance.colorScheme')}>
          {(id) => (
            <ColorSchemeSelect
              id={id}
              value={appearance.terminalColorScheme}
              onChange={(terminalColorScheme) => void update({ terminalColorScheme })}
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.appearance.font')}
          hint={t('settings.appearance.terminalFontHint')}
        >
          {(id) => (
            <FontFamilyInput
              id={id}
              value={appearance.terminalFontFamily}
              placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
              onCommit={(terminalFontFamily) => void update({ terminalFontFamily })}
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.appearance.fontSize')}
          hint={t('settings.appearance.terminalFontSizeHint', TERMINAL_FONT_SIZE_RANGE)}
        >
          {(id) => (
            <FontSizeInput
              id={id}
              value={appearance.terminalFontSize}
              range={TERMINAL_FONT_SIZE_RANGE}
              onCommit={(terminalFontSize) => void update({ terminalFontSize })}
            />
          )}
        </SettingRow>
        <SettingRow label={t('settings.appearance.fontWeight')}>
          {(id) => (
            <FontWeightSelect
              id={id}
              value={appearance.terminalFontWeight}
              onChange={(terminalFontWeight) => void update({ terminalFontWeight })}
            />
          )}
        </SettingRow>
        <SettingRow label={t('settings.appearance.fontWeightBold')}>
          {(id) => (
            <FontWeightSelect
              id={id}
              value={appearance.terminalFontWeightBold}
              onChange={(terminalFontWeightBold) => void update({ terminalFontWeightBold })}
            />
          )}
        </SettingRow>
      </ul>
    </section>
  );
}

function ResetButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <Button size="sm" variant="outline" disabled={disabled} onClick={onClick}>
      <RotateCcw />
      {t('settings.appearance.resetDefault')}
    </Button>
  );
}

/** 一行设置：左边是控件名（说明在悬停提示里），右边是控件；标签经 htmlFor 关联到控件 */
function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <li className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
      <label htmlFor={id} title={hint} className="min-w-0 text-sm">
        {label}
      </label>
      {children(id)}
    </li>
  );
}

/**
 * 失焦或回车时才提交，不会每按一次键就写一次 settings.json；不合法的值不提交，换回原值。
 * 草稿不合法时输入框标红。
 */
function DraftInput<T extends string | number>({
  value,
  parse,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  value: T;
  /** 草稿 → 要提交的值；不合法时为 null */
  parse: (draft: string) => T | null;
  onCommit: (next: T) => void;
}) {
  const shown = String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const next = parse(draft);
    if (next === null) {
      setDraft(shown);
      return;
    }
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <Input
      {...props}
      value={draft}
      aria-invalid={parse(draft) === null || undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // 输入法选词的回车不算提交
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit();
      }}
    />
  );
}

/** 字体：留空用默认；浏览器不认的写法（如没加引号、以数字开头的字体名）也不提交 */
function parseFontFamilyDraft(draft: string): string | null {
  const family = parseFontFamily(draft);
  return family !== null && (family === '' || CSS.supports('font-family', family)) ? family : null;
}

function FontFamilyInput({
  id,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder: string;
  onCommit: (family: string) => void;
}) {
  return (
    <DraftInput
      id={id}
      className="w-72"
      spellCheck={false}
      placeholder={placeholder}
      title={value || placeholder}
      value={value}
      parse={parseFontFamilyDraft}
      onCommit={onCommit}
    />
  );
}

function FontSizeInput({
  id,
  value,
  range,
  onCommit,
}: {
  id: string;
  value: number;
  range: { min: number; max: number };
  onCommit: (size: number) => void;
}) {
  return (
    <DraftInput
      id={id}
      className="w-24"
      type="number"
      min={range.min}
      max={range.max}
      step={1}
      value={value}
      parse={(draft) => parseFontSize(draft, range)}
      onCommit={onCommit}
    />
  );
}

function parseFontSize(draft: string, range: { min: number; max: number }): number | null {
  const size = draft.trim() === '' ? Number.NaN : Number(draft);
  return Number.isInteger(size) && size >= range.min && size <= range.max ? size : null;
}

function FontWeightSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: FontWeight;
  onChange: (weight: FontWeight) => void;
}) {
  const t = useT();
  const items = FONT_WEIGHTS.map((weight) => ({ value: weight, label: t(WEIGHT_LABELS[weight]) }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (isFontWeight(next)) onChange(next);
      }}
    >
      <SelectTrigger id={id} size="sm" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ColorSchemeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: TerminalColorSchemeId;
  onChange: (scheme: TerminalColorSchemeId) => void;
}) {
  return (
    <Select
      items={SCHEME_ITEMS}
      value={value}
      onValueChange={(next) => {
        if (isTerminalColorSchemeId(next)) onChange(next);
      }}
    >
      <SelectTrigger id={id} size="sm" className="w-56">
        <SelectValue>
          {(selected: unknown) => <SchemeLabel scheme={terminalColorSchemeOf(selected)} />}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {TERMINAL_COLOR_SCHEMES.map((scheme) => (
          <SelectItem key={scheme.id} value={scheme.id}>
            <SchemeLabel scheme={scheme} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 方案名与色块预览 */
function SchemeLabel({ scheme }: { scheme: TerminalColorScheme }) {
  const { colors } = scheme;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center gap-0.5 rounded-sm border px-1 py-0.5"
        style={{ backgroundColor: colors.background }}
      >
        {SWATCH_COLORS.map((key) => (
          <span
            key={key}
            className="size-2 rounded-full"
            style={{ backgroundColor: colors[key] }}
          />
        ))}
      </span>
      <span className="truncate">{scheme.name}</span>
    </span>
  );
}
