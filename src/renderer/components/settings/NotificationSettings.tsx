import type { NotificationPreferences } from '@shared/types/settings';
import { BellRing } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { MessageId } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { useNotificationSettingsStore } from '@/stores/settings';
import { InlineMessage, SettingsCard, SettingsRow, SettingsSection } from './common';

const SWITCHES: { key: keyof NotificationPreferences; label: MessageId; hint: MessageId }[] = [
  {
    key: 'enabled',
    label: 'settings.notifications.enabled',
    hint: 'settings.notifications.enabledHint',
  },
  {
    key: 'mainAgentOnly',
    label: 'settings.notifications.mainAgentOnly',
    hint: 'settings.notifications.mainAgentOnlyHint',
  },
  {
    key: 'askAndApproval',
    label: 'settings.notifications.askAndApproval',
    hint: 'settings.notifications.askAndApprovalHint',
  },
  { key: 'sound', label: 'settings.notifications.sound', hint: 'settings.notifications.soundHint' },
];

/** 通知：总开关关掉时其余开关与测试按钮不可用。设置由 Main 持有，改了立即生效。 */
export function NotificationSettings() {
  const preferences = useNotificationSettingsStore((state) => state.preferences);
  const error = useNotificationSettingsStore((state) => state.error);
  const refresh = useNotificationSettingsStore((state) => state.refresh);
  const update = useNotificationSettingsStore((state) => state.update);
  const test = useNotificationSettingsStore((state) => state.test);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const t = useT();
  const id = useId();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (preferences === null) {
    return (
      <p className="rounded-lg border px-4 py-3 text-muted-foreground text-sm">
        {error ? t('settings.notifications.loadFailed', { error }) : t('common.loading')}
      </p>
    );
  }

  const off = !preferences.enabled;
  const sendTest = async () => {
    setTesting(true);
    const result = await test();
    setTesting(false);
    setTestError(result.ok ? null : result.error);
  };

  return (
    <SettingsSection
      title={t('settings.sections.notifications')}
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={off || testing}
          onClick={() => void sendTest()}
        >
          <BellRing />
          {t('settings.notifications.test')}
        </Button>
      }
    >
      <SettingsCard>
        {SWITCHES.map(({ key, label, hint }) => (
          <SettingsRow
            key={key}
            label={t(label)}
            description={t(hint)}
            htmlFor={`${id}-${key}`}
            control={
              <Switch
                id={`${id}-${key}`}
                checked={preferences[key]}
                disabled={key !== 'enabled' && off}
                onCheckedChange={(checked) => void update({ [key]: checked })}
              />
            }
          />
        ))}
      </SettingsCard>
      {error && (
        <InlineMessage tone="error" className="mt-2 break-all">
          {error}
        </InlineMessage>
      )}
      {testError && (
        <InlineMessage tone="error" className="mt-2">
          {testError}
        </InlineMessage>
      )}
    </SettingsSection>
  );
}
