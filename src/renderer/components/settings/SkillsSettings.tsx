import type { SkillEntry } from '@shared/types/llm';
import { FolderPlus, ScanSearch, Sparkles, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/I18nProvider';
import { useSkillsStore } from '@/stores/skills';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { SkillScanDialog } from './SkillScanDialog';

type Status = { tone: 'error' | 'success'; text: string };

export function SkillsSettings() {
  const skills = useSkillsStore((state) => state.skills);
  const loaded = useSkillsStore((state) => state.loaded);
  const error = useSkillsStore((state) => state.error);
  const add = useSkillsStore((state) => state.add);
  const [status, setStatus] = useState<Status | null>(null);
  const [adding, setAdding] = useState(false);
  const [scanSession, setScanSession] = useState<number | null>(null);
  const sessions = useRef(0);
  const t = useT();

  const openScan = () => {
    sessions.current += 1;
    setScanSession(sessions.current);
  };

  // Main 弹目录选择框并校验 SKILL.md，Renderer 不传路径
  const addDirectory = async () => {
    setAdding(true);
    const result = await add();
    setAdding(false);
    if (result.ok) {
      setStatus({
        tone: 'success',
        text: t('settings.skills.registered', {
          names: result.skills.map((skill) => skill.name).join(t('settings.import.itemSeparator')),
        }),
      });
    } else if (result.code !== 'canceled') {
      setStatus({ tone: 'error', text: result.error });
    }
  };

  return (
    <section>
      <SectionHeader title={t('settings.skills.title')}>
        <Button size="sm" variant="outline" onClick={openScan}>
          <ScanSearch />
          {t('settings.skills.scan')}
        </Button>
        <Button size="sm" disabled={adding} onClick={() => void addDirectory()}>
          <FolderPlus />
          {t('settings.skills.addDir')}
        </Button>
      </SectionHeader>

      {status && (
        <InlineMessage tone={status.tone} className="mb-3 break-all">
          {status.text}
        </InlineMessage>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      {loaded && skills.length === 0 ? (
        <EmptyState icon={Sparkles} title={t('settings.skills.empty')}>
          <Button size="sm" variant="outline" onClick={openScan}>
            <ScanSearch />
            {t('settings.skills.scan')}
          </Button>
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              onError={(text) => setStatus({ tone: 'error', text })}
            />
          ))}
        </ul>
      )}

      <SkillScanDialog
        session={scanSession}
        onClose={() => setScanSession(null)}
        onRegistered={(text) => setStatus({ tone: 'success', text })}
      />
    </section>
  );
}

function SkillRow({ skill, onError }: { skill: SkillEntry; onError: (message: string) => void }) {
  const toggle = useSkillsStore((state) => state.toggle);
  const remove = useSkillsStore((state) => state.remove);
  const t = useT();

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{skill.name}</span>
          {!skill.enabled && <Badge>{t('common.disabled')}</Badge>}
        </div>
        {skill.description && (
          <p className="line-clamp-2 text-muted-foreground text-xs">{skill.description}</p>
        )}
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={skill.path}>
          {skill.path}
        </p>
      </div>
      <Switch
        className="mt-1"
        checked={skill.enabled}
        aria-label={t('common.enableItem', { name: skill.name })}
        onCheckedChange={async (enabled) => {
          const result = await toggle(skill.id, enabled);
          if (!result.ok) onError(result.error);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('common.removeItem', { name: skill.name })}
            />
          }
          onClick={async () => {
            const result = await remove(skill.id);
            if (!result.ok) onError(result.error);
          }}
        >
          <Trash2 />
        </TooltipTrigger>
        <TooltipContent>{t('settings.skills.removeHint')}</TooltipContent>
      </Tooltip>
    </li>
  );
}
