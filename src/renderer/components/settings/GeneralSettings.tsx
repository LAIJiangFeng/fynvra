import { errorMessage } from '@shared/guards';
import { isLanguage, LANGUAGES, type Language, type Locale } from '@shared/i18n';
import {
  type AvailableShells,
  languageOf,
  type Preferences,
  parseShellPreference,
  type ShellPreference,
  type ShellTarget,
} from '@shared/types/settings';
import { FolderOpen, Save } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useT } from '@/i18n/I18nProvider';
import { useSettingsStore } from '@/stores/settings';
import { InlineMessage, SettingsCard, SettingsRow, SettingsSection } from './common';
import { NetworkProxySettings } from './NetworkProxySettings';
import { UpdateSettings } from './UpdateSettings';

/** 通用（应用级）：界面语言、Shell、网络代理、更新。对话相关的设置在「对话」页 */
export function GeneralSettings() {
  return (
    <div className="grid gap-8">
      <LanguageSection />
      <ShellsSection />
      <NetworkProxySettings />
      <UpdateSettings />
    </div>
  );
}

// --- language ---
/** 语言名用各自的写法、不随界面语言变：切错了也认得出回去的那一项 */
const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { 'zh-CN': '简体中文', en: 'English' };

function LanguageSection() {
  const language = useSettingsStore((state) => languageOf(state));
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const t = useT();
  const id = useId();
  const items = LANGUAGES.map((value: Language) => ({
    value,
    label: value === 'system' ? t('settings.general.followSystem') : LANGUAGE_NAMES[value],
  }));
  return (
    <SettingsSection title={t('settings.general.basic')}>
      <SettingsCard>
        <SettingsRow
          label={t('settings.general.language')}
          description={t('settings.general.languageHint')}
          htmlFor={id}
          control={
            <Select
              items={items}
              value={language}
              onValueChange={(next) => {
                if (isLanguage(next)) setLanguage(next);
              }}
            >
              <SelectTrigger id={id} size="sm" className="w-36">
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
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

// --- shells ---
function ShellsSection() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [available, setAvailable] = useState<AvailableShells | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const windows = window.fynvra.window.platform === 'win32';
  const t = useT();

  useEffect(() => {
    let request = 0;
    const load = () => {
      const current = ++request;
      void Promise.all([window.fynvra.settings.get(), window.fynvra.settings.availableShells()])
        .then(([saved, shells]) => {
          if (current !== request) return;
          if (saved.ok) setPreferences(saved.preferences);
          if (shells.ok) setAvailable(shells);
          if (!saved.ok) setError(saved.error);
          else if (!shells.ok) setError(shells.error);
        })
        .catch((failure) => {
          if (current === request) setError(errorMessage(failure));
        });
    };
    const unsubscribe = window.fynvra.settings.onChanged(load);
    load();
    return () => {
      request += 1;
      unsubscribe();
    };
  }, []);

  const save = async (target: ShellTarget, value: ShellPreference | undefined, browse = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = browse
        ? await window.fynvra.settings.pickShell(target)
        : await window.fynvra.settings.update({ [target]: value });
      if (result.ok) setPreferences(result.preferences);
      else if (!('code' in result && result.code === 'canceled')) setError(result.error);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('settings.general.terminal')}>
      <SettingsCard>
        {(windows ? (['agentShell', 'terminalShell'] as const) : (['terminalShell'] as const)).map(
          (target) => (
            <ShellPreferenceRow
              key={target}
              target={target}
              preference={preferences?.[target]}
              legacy={target === 'agentShell' ? preferences?.shellPath : undefined}
              available={available}
              disabled={busy || !preferences || !available}
              windows={windows}
              onSave={(value) => void save(target, value)}
              onBrowse={() => void save(target, undefined, true)}
            />
          )
        )}
      </SettingsCard>
      {error && (
        <InlineMessage tone="error" className="mt-2">
          {error}
        </InlineMessage>
      )}
      {!available && !error && (
        <p className="mt-2 text-muted-foreground text-xs">{t('common.loading')}</p>
      )}
    </SettingsSection>
  );
}

function ShellPreferenceRow({
  target,
  preference,
  legacy,
  available,
  disabled,
  windows,
  onSave,
  onBrowse,
}: {
  target: ShellTarget;
  preference: ShellPreference | undefined;
  legacy?: string;
  available: AvailableShells | null;
  disabled: boolean;
  windows: boolean;
  onSave: (value: ShellPreference | undefined) => void;
  onBrowse: () => void;
}) {
  const t = useT();
  const id = useId();
  const agent = target === 'agentShell';
  const [editingCustom, setEditingCustom] = useState(false);
  const savedPath = preference?.kind === 'custom' ? preference.path : '';
  const [path, setPath] = useState(savedPath);
  useEffect(() => {
    setPath(savedPath);
  }, [savedPath]);
  const custom = !legacy && (editingCustom || preference?.kind === 'custom');
  const value = legacy || custom ? 'custom' : (preference?.kind ?? 'default');
  const resolved = agent ? available?.agentPath : available?.terminalPath;
  const items = [
    {
      value: 'default',
      label: t(
        agent
          ? 'settings.general.agentShellDefault'
          : windows
            ? 'settings.general.terminalShellDefault'
            : 'settings.general.loginShellDefault'
      ),
    },
    ...(available?.shells ?? [])
      .filter((shell) => !agent || shell.agentSupported)
      .map((shell) => ({
        value: shell.id,
        label: shell.id === 'login' ? t('settings.general.loginShell') : shell.label,
      })),
    {
      value: 'custom',
      label: t(legacy ? 'settings.general.shellCustom' : 'settings.general.shellCustomChoose'),
    },
  ];
  if (!items.some((item) => item.value === value)) {
    items.push({ value, label: t('settings.general.shellUnavailable', { name: value }) });
  }
  const parsed = parseShellPreference({ kind: 'custom', path }, agent);
  return (
    <SettingsRow
      label={t(agent ? 'settings.general.agentShell' : 'settings.general.terminalShell')}
      description={t(
        agent ? 'settings.general.agentShellHint' : 'settings.general.terminalShellHint'
      )}
      htmlFor={id}
      control={
        <div className="grid w-64 gap-1">
          <Select
            items={items}
            value={value}
            disabled={disabled || Boolean(legacy)}
            onValueChange={(next) => {
              if (next === 'custom') {
                setEditingCustom(true);
                return;
              }
              const choice =
                next === 'default' ? undefined : parseShellPreference({ kind: next }, agent);
              if (next !== 'default' && !choice) return;
              setEditingCustom(false);
              onSave(choice);
            }}
          >
            <SelectTrigger id={id} size="sm" className="w-full" title={legacy ?? resolved}>
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
          <p
            className="truncate font-mono text-muted-foreground text-xs"
            title={legacy ?? resolved}
          >
            {legacy ?? resolved ?? t('settings.general.shellNotFound')}
          </p>
        </div>
      }
    >
      {legacy ? (
        <p className="text-muted-foreground text-xs">{t('settings.general.shellLegacyHint')}</p>
      ) : custom ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed) onSave(parsed);
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              aria-label={t('settings.general.shellPath')}
              placeholder={t('settings.general.shellPath')}
              value={path}
              disabled={disabled}
              onChange={(event) => setPath(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={onBrowse}
            >
              <FolderOpen />
              {t('settings.general.shellBrowse')}
            </Button>
            <Button type="submit" size="sm" disabled={disabled || !parsed}>
              <Save />
              {t('common.save')}
            </Button>
          </div>
          {agent && (
            <p className="text-muted-foreground text-xs">
              {t('settings.general.shellCommandHint')}
            </p>
          )}
        </form>
      ) : null}
    </SettingsRow>
  );
}
