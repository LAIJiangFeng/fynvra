import type { NotificationPreferences } from '@shared/types/settings';
import { BellRing } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useNotificationSettingsStore } from '@/stores/settings';
import { InlineMessage } from './common';

/** 页上的开关：控件名说明不了的放悬停提示 */
const SWITCHES: { key: keyof NotificationPreferences; label: string; hint?: string }[] = [
  { key: 'enabled', label: '桌面通知' },
  { key: 'mainAgentOnly', label: '仅主 agent 完成', hint: 'worker 的完成与失败不弹' },
  { key: 'askAndApproval', label: '提问与审批', hint: 'worker 提问、上报与审批请求' },
  { key: 'sound', label: '声音' },
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (preferences === null) {
    return (
      <p className="rounded-lg border px-4 py-3 text-muted-foreground text-sm">
        {error ? `读取失败：${error}` : '读取中…'}
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
    <div className="grid gap-4">
      <ul className="divide-y rounded-lg border">
        {SWITCHES.map(({ key, label, hint }) => (
          <SwitchRow
            key={key}
            label={label}
            hint={hint}
            checked={preferences[key]}
            disabled={key !== 'enabled' && off}
            onChange={(checked) => void update({ [key]: checked })}
          />
        ))}
      </ul>
      {error && (
        <InlineMessage tone="error" className="break-all">
          {error}
        </InlineMessage>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={off || testing}
          onClick={() => void sendTest()}
        >
          <BellRing />
          发送测试通知
        </Button>
        {testError && <InlineMessage tone="error">{testError}</InlineMessage>}
      </div>
    </div>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3" title={hint}>
      <label htmlFor={id} className={cn('text-sm', disabled && 'text-muted-foreground')}>
        {label}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </li>
  );
}
