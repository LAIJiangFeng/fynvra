import { errorMessage } from '@shared/guards';
import type { GitStatus } from '@shared/types/git';
import { Download, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/I18nProvider';
import { runPendingGitInit } from '@/lib/gitInit';
import { Field, InlineMessage, SectionHeader } from './common';
import { GitCompatibilitySection, GitWorktreeSettings } from './GitWorktreeSettings';

type Message = { tone: 'error' | 'success' | 'muted'; text: string };

const LINUX_COMMANDS = ['sudo apt install git', 'sudo dnf install git', 'sudo pacman -S git'];

/** Git：检测、一键安装（Windows 便携 MinGit / macOS 系统安装）、提交身份、兼容模式与 worktree。路径与地址都只在 Main */
export function GitSettings() {
  const t = useT();
  const platform = window.fynvra.window.platform;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState<Message | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [identityMessage, setIdentityMessage] = useState<Message | null>(null);
  const nameId = useId();
  const emailId = useId();

  const apply = useCallback((next: GitStatus) => {
    setStatus(next);
    setName(next.userName);
    setEmail(next.userEmail);
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const result = await window.fynvra.git.status();
      if (result.ok) apply(result.status);
      else setInstallMessage({ tone: 'error', text: result.error });
    } catch (error) {
      setInstallMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setChecking(false);
    }
  }, [apply]);

  useEffect(() => {
    void check();
  }, [check]);

  const install = async () => {
    setInstalling(true);
    setInstallMessage(null);
    try {
      const result = await window.fynvra.git.install();
      if (!result.ok) setInstallMessage({ tone: 'error', text: result.error });
      else if (result.status) {
        apply(result.status);
        setInstallMessage({ tone: 'success', text: t('settings.git.installed') });
      } else if (result.started) {
        setInstallMessage({ tone: 'muted', text: t('settings.git.macStarted') });
      }
    } catch (error) {
      setInstallMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setInstalling(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setIdentityMessage(null);
    try {
      const result = await window.fynvra.git.setIdentity({ name, email });
      if (result.ok) {
        apply(result.status);
        setIdentityMessage({ tone: 'success', text: t('settings.git.identitySaved') });
      } else setIdentityMessage({ tone: 'error', text: result.error });
    } catch (error) {
      setIdentityMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const available = status?.available === true;

  // git 变为可用时接续侧栏发起的初始化；没有待办时什么都不做
  useEffect(() => {
    if (available) void runPendingGitInit();
  }, [available]);
  const identityDisabled = !available || saving;

  return (
    <div className="grid gap-8">
      <section aria-label={t('settings.git.statusTitle')}>
        <SectionHeader title={t('settings.git.statusTitle')}>
          <Button
            size="sm"
            variant="outline"
            disabled={checking || installing}
            onClick={() => void check()}
          >
            <RefreshCw className={checking ? 'animate-spin' : undefined} />
            {t('settings.git.recheck')}
          </Button>
          {status && !available && (platform === 'win32' || platform === 'darwin') && (
            <Button size="sm" disabled={installing} onClick={() => void install()}>
              <Download />
              {installing
                ? t('settings.git.installing')
                : t(
                    platform === 'win32' ? 'settings.git.installWindows' : 'settings.git.installMac'
                  )}
            </Button>
          )}
        </SectionHeader>
        <div className="grid gap-2 rounded-lg border px-4 py-3">
          <p className="font-medium text-sm" role="status">
            {!status
              ? t('common.loading')
              : available
                ? t('settings.git.available', {
                    version: status.version ?? '',
                    source: t(
                      status.source === 'bundled'
                        ? 'settings.git.sourceBundled'
                        : 'settings.git.sourceSystem'
                    ),
                  })
                : t('settings.git.missing')}
          </p>
          {status && !available && platform === 'win32' && (
            <p className="text-muted-foreground text-xs">{t('settings.git.windowsHint')}</p>
          )}
          {status && !available && platform === 'linux' && (
            <div className="grid gap-1">
              <p className="text-muted-foreground text-xs">{t('settings.git.linuxHint')}</p>
              {LINUX_COMMANDS.map((command) => (
                <code key={command} className="select-all font-mono text-xs">
                  {command}
                </code>
              ))}
            </div>
          )}
          {installMessage && (
            <InlineMessage tone={installMessage.tone} className="break-all">
              {installMessage.text}
            </InlineMessage>
          )}
        </div>
      </section>

      <section aria-label={t('settings.git.identityTitle')}>
        <SectionHeader title={t('settings.git.identityTitle')}>
          <Button size="sm" disabled={identityDisabled} onClick={() => void save()}>
            <Save />
            {t('settings.git.save')}
          </Button>
        </SectionHeader>
        <fieldset disabled={!available} className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.git.userName')} htmlFor={nameId}>
            <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t('settings.git.userEmail')} htmlFor={emailId}>
            <Input
              id={emailId}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
        </fieldset>
        {available && (!status?.userName || !status.userEmail) && (
          <InlineMessage className="mt-2">{t('settings.git.identityHint')}</InlineMessage>
        )}
        {identityMessage && (
          <InlineMessage tone={identityMessage.tone} className="mt-2">
            {identityMessage.text}
          </InlineMessage>
        )}
      </section>

      <GitCompatibilitySection />
      <GitWorktreeSettings />
    </div>
  );
}
