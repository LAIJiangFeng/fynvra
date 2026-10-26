import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { terminalResources } from '@/stores/terminals';

export function TerminalPane({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const resource = terminalResources.get(id);
    const element = host.current;
    if (!resource || !element) return;
    element.append(resource.container);
    if (!resource.opened) {
      resource.terminal.open(resource.container);
      resource.opened = true;
    }
    const fit = () => {
      if (!active || element.clientWidth === 0 || element.clientHeight === 0) return;
      resource.fit.fit();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    const frame = requestAnimationFrame(() => {
      fit();
      if (active) {
        resource.terminal.refresh(0, resource.terminal.rows - 1);
        resource.terminal.focus();
      }
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      // Switching workspace detaches the screen, but keeps its PTY and scrollback alive.
      resource.container.remove();
    };
  }, [id, active]);
  return <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[#18181b] p-3" />;
}
