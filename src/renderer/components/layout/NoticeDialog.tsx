import { useState } from 'react';
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
import { useT } from '@/i18n/I18nProvider';
import { useWorkspacesStore } from '@/stores/workspaces';

/** 展示工作区操作的失败原因（如所选目录不是 git 仓库），确认后清除。 */
export function NoticeDialog() {
  const notice = useWorkspacesStore((state) => state.notice);
  const dismiss = useWorkspacesStore((state) => state.dismissNotice);
  const t = useT();
  // 关闭动画期间 notice 已清空，沿用上一条内容避免弹窗闪成空白
  const [shown, setShown] = useState(notice);
  if (notice && notice !== shown) setShown(notice);

  return (
    <Dialog
      open={notice !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{shown?.title}</DialogTitle>
          <DialogDescription className="break-all">{shown?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button />}>{t('common.gotIt')}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
