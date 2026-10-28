import { parseNetworkProxy } from '@shared/networkProxy';
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
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { createNetworkProxyStore } from '@/stores/createNetworkProxyStore';
import { InlineMessage, SectionHeader } from './common';

export function NetworkProxySettings() {
  const [useStore] = useState(() => createNetworkProxyStore(window.fynvra.settings));
  const state = useStore();
  const t = useT();
  const id = useId();
  useEffect(() => state.connect(), [state.connect]);
  const { draft, edit } = state;
  const valid = parseNetworkProxy(draft) !== null;
  const disabled = !state.loaded || state.saving;
  const modes = [
    { value: 'environment', label: t('settings.network.environment') },
    { value: 'manual', label: t('settings.network.manual') },
  ];
  return (
    <section>
      <SectionHeader title={t('settings.network.title')} />
      <div className="grid gap-3 rounded-lg border p-4">
        <p className="text-muted-foreground text-xs">{t('settings.network.scope')}</p>
        <Select
          items={modes}
          value={draft.mode}
          disabled={disabled}
          onValueChange={(mode) => {
            if (mode === 'environment') edit({ mode, gitCompatibility: draft.gitCompatibility });
            if (mode === 'manual')
              edit({ mode, url: '', gitCompatibility: draft.gitCompatibility });
          }}
        >
          <SelectTrigger className="w-full" aria-label={t('settings.network.title')}>
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
        {draft.mode === 'manual' && (
          <>
            <label htmlFor={`${id}-url`} className="text-sm">
              {t('settings.network.address')}
            </label>
            <Input
              id={`${id}-url`}
              value={draft.url}
              placeholder="http://127.0.0.1:7890"
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => edit({ ...draft, url: event.target.value })}
            />
            <p className="text-muted-foreground text-xs">{t('settings.network.manualHint')}</p>
            {!valid && draft.url !== '' && (
              <InlineMessage tone="error">{t('settings.network.invalid')}</InlineMessage>
            )}
          </>
        )}
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={`${id}-compat`} className="text-sm">
            {t('settings.network.compatibility')}
          </label>
          <Switch
            id={`${id}-compat`}
            checked={draft.gitCompatibility}
            disabled={disabled}
            onCheckedChange={(gitCompatibility) => edit({ ...draft, gitCompatibility })}
          />
        </div>
        <p className="text-muted-foreground text-xs">{t('settings.network.compatibilityHint')}</p>
        <p className="text-muted-foreground text-xs">{t('settings.network.effective')}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void state.save(true)}
          >
            {t('settings.general.resetDefault')}
          </Button>
          {state.testing ? (
            <Button size="sm" variant="outline" onClick={state.cancel}>
              {t('common.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !valid}
              onClick={() => void state.test()}
            >
              {t('settings.network.test')}
            </Button>
          )}
          <Button size="sm" disabled={disabled || !valid} onClick={() => void state.save()}>
            {t('common.save')}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t('settings.network.testHint')}</p>
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
    </section>
  );
}
