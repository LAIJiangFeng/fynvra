import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
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

function sourceStatus(source: SkillScanSource): string {
  if (source.status === 'not-found') return '未找到目录';
  if (source.status === 'error') return '读取失败';
  return `${source.count} 个`;
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
    const skipped = added.skipped.length > 0 ? `，跳过 ${added.skipped.length} 个` : '';
    onRegistered(`已登记 ${added.skills.length} 个技能${skipped}`);
  };

  const selectable = result?.candidates.filter((item) => !item.registered) ?? [];

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>扫描本机技能</DialogTitle>
        <DialogDescription>
          来自 ~/.claude/skills、~/.codex/skills 与 ~/.pi/agent/skills；同名技能只保留先出现的来源。
        </DialogDescription>
      </DialogHeader>

      {!result && !error && (
        <p className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          正在扫描…
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
                  {source.label}：{sourceStatus(source)}
                </Badge>
              </li>
            ))}
          </ul>

          {result.candidates.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              没有找到含 SKILL.md 的技能目录
            </p>
          ) : (
            <div className="grid min-w-0 gap-2">
              <div className="flex items-center justify-between text-muted-foreground text-xs">
                <span>
                  共 {result.candidates.length} 个，已选 {selected.length}
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(selectable.map((item) => item.id))}
                  >
                    全选
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                    全不选
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
                        {candidate.registered && <Badge>已登记</Badge>}
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
                      aria-label={`登记 ${candidate.name}`}
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
        <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
        <Button
          disabled={!result || selected.length === 0 || registering}
          onClick={() => void register()}
        >
          {registering ? '登记中…' : `登记所选（${selected.length}）`}
        </Button>
      </DialogFooter>
    </div>
  );
}
