import type { SkillEntry } from '@shared/types/llm';
import { FolderPlus, ScanSearch, Sparkles, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
        text: `已登记 ${result.skills.map((skill) => skill.name).join('、')}`,
      });
    } else if (result.code !== 'canceled') {
      setStatus({ tone: 'error', text: result.error });
    }
  };

  return (
    <section>
      <SectionHeader
        title="技能"
        description="按引用登记技能目录（含 SKILL.md），文件留在原处，不复制内容。角色从这里挑选技能。"
      >
        <Button size="sm" variant="outline" onClick={openScan}>
          <ScanSearch />
          扫描本机
        </Button>
        <Button size="sm" disabled={adding} onClick={() => void addDirectory()}>
          <FolderPlus />
          添加目录
        </Button>
      </SectionHeader>

      {status && (
        <InlineMessage tone={status.tone} className="mb-3 break-all">
          {status.text}
        </InlineMessage>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      {loaded && skills.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="还没有登记技能"
          description="扫描本机 Claude Code、Codex、pi 的技能目录，或手动添加一个含 SKILL.md 的目录。"
        >
          <Button size="sm" variant="outline" onClick={openScan}>
            <ScanSearch />
            扫描本机
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

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{skill.name}</span>
          {!skill.enabled && <Badge>已停用</Badge>}
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
        aria-label={`启用 ${skill.name}`}
        onCheckedChange={async (enabled) => {
          const result = await toggle(skill.id, enabled);
          if (!result.ok) onError(result.error);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-xs" aria-label={`移除 ${skill.name}`} />}
          onClick={async () => {
            const result = await remove(skill.id);
            if (!result.ok) onError(result.error);
          }}
        >
          <Trash2 />
        </TooltipTrigger>
        <TooltipContent>从注册表移除（不删除文件）</TooltipContent>
      </Tooltip>
    </li>
  );
}
