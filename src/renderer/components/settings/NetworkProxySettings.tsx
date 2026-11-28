import { parseNetworkProxy, type SystemProxyStatus } from '@shared/networkProxy';
import { Loader2, RotateCcw, Save, Zap } from 'lucide-react';
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
import { createNetworkProxyStore } from '@/stores/createNetworkProxyStore';
import { InlineMessage, SettingsCard, SettingsRow, SettingsSection } from './common';

/** 网络代理；Git 兼容模式的开关在 Git 页，这里的草稿只把已保存的 gitCompatibility 原样带回 */
export function NetworkProxySettings() {
  const [useStore] = useState(() => createNetworkProxyStore(window.fynvra.settings));
  const state = useStore();
  const t = useT();
  const id = useId();
  useEffect(() => state.connect(), [state.connect]);
  // 页面打开时查一次系统代理检测结果
  const [system, setSystem] = useState<SystemProxyStatus | null>(null);
  useEffect(() => {
    let alive = true;
    window.fynvra.settings
      .systemProxy()
      .then((response) => {
        if (alive && response.ok) setSystem(response.status);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const { draft, edit } = state;
  const valid = parseNetworkProxy(draft) !== null;
  const disabled = !state.loaded || state.saving;
  const modes = [
    { value: 'system', label: t('settings.network.system') },
    { value: 'environment', label: t('settings.network.environment') },
    { value: 'manual', label: t('settings.network.manual') },
  ];
  return (
    <SettingsSection
      title={t('settings.network.title')}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void state.save(true)}
          >
            <RotateCcw />
            {t('settings.general.resetDefault')}
          </Button>
          {state.testing ? (
            <Button size="sm" variant="outline" onClick={state.cancel}>
              <Loader2 className="animate-spin" />
              {t('common.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !valid}
              title={t('settings.network.testHint')}
              onClick={() => void state.test()}
            >
              <Zap />
              {t('settings.network.test')}
            </Button>
          )}
          <Button size="sm" disabled={disabled || !valid} onClick={() => void state.save()}>
            <Save />
            {t('common.save')}
          </Button>
        </>
      }
    >
      <SettingsCard>
        <SettingsRow
          label={t('settings.network.mode')}
          description={t('settings.network.scope')}
          htmlFor={`${id}-mode`}
          control={
            <Select
              items={modes}
              value={draft.mode}
              disabled={disabled}
              onValueChange={(mode) => {
                if (mode === 'system' || mode === 'environment')
                  edit({ mode, gitCompatibility: draft.gitCompatibility });
                if (mode === 'manual')
                  edit({ mode, url: '', gitCompatibility: draft.gitCompatibility });
              }}
            >
              <SelectTrigger id={`${id}-mode`} size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modes.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          {draft.mode === 'system' ? (
            system && (
              <InlineMessage tone={system.kind === 'unsupported' ? 'error' : 'muted'}>
                {system.kind === 'proxy'
                  ? t('settings.network.systemStatus.proxy', { url: system.url })
                  : t(`settings.network.systemStatus.${system.kind}`)}
              </InlineMessage>
            )
          ) : draft.mode === 'environment' ? (
            <p className="text-muted-foreground text-xs">{t('settings.network.environmentHint')}</p>
          ) : null}
        </SettingsRow>
        {draft.mode === 'manual' && (
          <SettingsRow
            label={t('settings.network.address')}
            description={t('settings.network.manualHint')}
            htmlFor={`${id}-url`}
            control={
              <Input
                id={`${id}-url`}
                className="w-64"
                value={draft.url}
                placeholder="http://127.0.0.1:7890"
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => edit({ ...draft, url: event.target.value })}
              />
            }
          >
            {!valid && draft.url !== '' ? (
              <InlineMessage tone="error">{t('settings.network.invalid')}</InlineMessage>
            ) : null}
          </SettingsRow>
        )}
      </SettingsCard>
      <div className="mt-2 grid gap-1">
        <p className="text-muted-foreground text-xs">{t('settings.network.effective')}</p>
        <div aria-live="polite">
          {state.testing && <p className="text-sm">{t('settings.network.testing')}</p>}
          {state.saved && (
            <InlineMessage tone="success">{t('settings.network.saved')}</InlineMessage>
          )}
          {state.error && (
            <InlineMessage tone="error">{t(`settings.network.error.${state.error}`)}</InlineMessage>
          )}
          {state.result && (
            <ul className="grid gap-1 text-sm">
              {(['api', 'git'] as const).map((kind) => {
                const probe = state.result?.[kind];
                return (
                  probe && (
                    <li key={kind}>
                      {t(`settings.network.${kind}`)}:{' '}
                      {t(`settings.network.status.${probe.status}`)}
                      {probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : ''}
                    </li>
                  )
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
