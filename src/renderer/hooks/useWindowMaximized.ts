import { useEffect, useState } from 'react';

/** 当前窗口是否最大化：初值向 Main 查询，之后跟随 Main 推送的变化。 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    void window.fynvra.window.isMaximized().then((result) => {
      if (active && result.ok) setMaximized(result.maximized);
    });
    const unsubscribe = window.fynvra.window.onMaximizedChange(setMaximized);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return maximized;
}
