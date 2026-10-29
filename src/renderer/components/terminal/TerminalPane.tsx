import '@xterm/xterm/css/xterm.css';
import { ContextMenu } from '@base-ui/react/context-menu';
import { useEffect, useRef, useState } from 'react';
import { DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useT } from '@/i18n/I18nProvider';
import { clearTerminalScreen, terminalResources } from '@/stores/terminals';

export function TerminalPane({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const t = useT();
  useEffect(() => {
    setMenuOpen(false);
    const resource = terminalResources.get(id);
    const element = host.current;
    if (!resource || !element) return;
    element.append(resource.container);
    if (!resource.opened) {
      resource.terminal.open(resource.container);
      resource.opened = true;
    }
    setHasSelection(resource.terminal.hasSelection());
    const selectionListener = resource.terminal.onSelectionChange(() =>
      setHasSelection(resource.terminal.hasSelection())
    );
    const fitToHost = () => {
      if (!active || element.clientWidth === 0 || element.clientHeight === 0) return;
      resource.fit.fit();
    };
    const observer = new ResizeObserver(fitToHost);
    observer.observe(element);
    const frame = requestAnimationFrame(() => {
      fitToHost();
      if (active) {
        resource.terminal.refresh(0, resource.terminal.rows - 1);
        resource.terminal.focus();
      }
    });
    return () => {
      observer.disconnect();
      selectionListener.dispose();
      cancelAnimationFrame(frame);
      // Switching workspace detaches the screen, but keeps its PTY and scrollback alive.
      resource.container.remove();
    };
  }, [id, active]);
  return (
    <ContextMenu.Root open={active && menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger
        ref={host}
        className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[#18181b] p-3"
      />
      <DropdownMenuContent
        sideOffset={0}
        finalFocus={() => (active ? terminalResources.get(id)?.terminal.textarea : false)}
      >
        <DropdownMenuItem
          disabled={!hasSelection}
          onClick={() => void terminalResources.get(id)?.copySelection()}
        >
          {t('terminals.copy')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void terminalResources.get(id)?.pasteClipboard()}>
          {t('terminals.paste')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => terminalResources.get(id)?.terminal.selectAll()}>
          {t('terminals.selectAll')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => clearTerminalScreen(id)}>
          {t('terminals.clear')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </ContextMenu.Root>
  );
}
