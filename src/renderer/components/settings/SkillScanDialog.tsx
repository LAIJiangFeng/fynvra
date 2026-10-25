import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { useSkillsStore } from '@/stores/skills';
import type {
  SkillCandidate,
  SkillScanSource,
  SkillSourceId,
} from '../../../preload/domains/skills';
import { InlineMessage } from './common';

const SOURCE_LABELS: Record<SkillSourceId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'pi',
};

function sourceStatus(source: SkillScanSource, t: T): string {
  if (source.status === 'not-found') return t('settings.skills.dirNotFound');
  if (source.status === 'error') return t('common.loadFailed');
  return t('settings.skills.count', { count: source.count });
}

/** 扫描本机技能并勾选登记。每次打开（session 变化）重新扫描。 */
export function SkillScanDialog({
  session,
  onClose,
  onRegistered,
}: {
  /** 打开时是本次扫描的序号，关闭时为 null */
  session: number | null;
  onClose: () => void;
  onRegistered: (message: string) => void;
}) {
  // 关闭动画期间沿用上一次的内容，避免弹窗闪成空白
  const [shown, setShown] = useState(session);
  if (session !== null && session !== shown) setShown(session);

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {shown !== null && (
          <ScanContent
            key={shown}
            onRegistered={(message) => {
              onRegistered(message);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ScanContent({ onRegistered }: { onRegistered: (message: string) => void }) {
  const scan = useSkillsStore((state) => state.scan);
  const add = useSkillsStore((state) => state.add);
  const [result, setResult] = useState<{
    candidates: SkillCandidate[];
    sources: SkillScanSource[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [registering, setRegistering] = useState(false);
  const t = useT();

  useEffect(() => {
    let active = true;
    void scan().then((scanned) => {
      if (!active) return;
      if (!scanned.ok) {
        setError(scanned.error);
        return;
      }
      setResult({ candidates: scanned.candidates, sources: scanned.sources });
      // 默认勾选还没登记的
      setSelected(scanned.candidates.filter((item) => !item.registered).map((item) => item.id));
    });
    return () => {
      active = false;
    };
  }, [scan]);

  const register = async () => {
    setRegistering(true);
    const added = await add({ candidateIds: selected });
    setRegistering(false);
    if (!added.ok) {
      setError(added.error);
      return;
    }
    onRegistered(
      added.skipped.length > 0
        ? t('settings.skills.registeredSkipped', {
            count: added.skills.length,
            skipped: added.skipped.length,
          })
        : t('settings.skills.registeredCount', { count: added.skills.length })
    );
  };

  const selectable = result?.candidates.filter((item) => !item.registered) ?? [];

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{t('settings.skills.scanTitle')}</DialogTitle>
      </DialogHeader>

      {!result && !error && (
        <p className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.skills.scanning')}
        </p>
      )}

      {result && (
        <>
          <ul className="flex flex-wrap gap-2">
            {result.sources.map((source) => (
              <li key={source.source}>
                <Badge
                  variant={source.status === 'error' ? 'destructive' : 'outline'}
                  title={source.error ?? source.root}
                >
                  {t('common.labeled', { label: source.label, text: sourceStatus(source, t) })}
                </Badge>
              </li>
            ))}
          </ul>

          {result.candidates.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              {t('settings.skills.none')}
            </p>
          ) : (
            <div className="grid min-w-0 gap-2">
              <div className="flex items-center justify-between text-muted-foreground text-xs">
                <span>
                  {t('settings.import.selectedOf', {
                    total: result.candidates.length,
                    selected: selected.length,
                  })}
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(selectable.map((item) => item.id))}
                  >
                    {t('common.selectAll')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                    {t('settings.skills.selectNone')}
                  </Button>
                </span>
              </div>
              <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-md border">
                {result.candidates.map((candidate) => (
                  <li key={candidate.id} className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="font-medium">{candidate.name}</span>
                        <Badge variant="outline">{SOURCE_LABELS[candidate.source]}</Badge>
                        {candidate.registered && (
                          <Badge>{t('settings.skills.alreadyRegistered')}</Badge>
                        )}
                      </div>
                      {candidate.description && (
                        <p className="line-clamp-2 text-muted-foreground text-xs">
                          {candidate.description}
                        </p>
                      )}
                      <p
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={candidate.path}
                      >
                        {candidate.path}
                      </p>
                    </div>
                    <Switch
                      className="mt-1"
                      checked={selected.includes(candidate.id)}
                      disabled={candidate.registered}
                      aria-label={t('settings.skills.register', { name: candidate.name })}
                      onCheckedChange={(on) =>
                        setSelected((current) =>
                          on
                            ? [...current, candidate.id]
                            : current.filter((id) => id !== candidate.id)
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{t('common.cancel')}</DialogClose>
        <Button
          disabled={!result || selected.length === 0 || registering}
          onClick={() => void register()}
        >
          {registering
            ? t('settings.skills.registering')
            : t('settings.skills.registerPicked', { count: selected.length })}
        </Button>
      </DialogFooter>
    </div>
  );
}
