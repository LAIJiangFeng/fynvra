import type { ChatImage } from '@shared/types/chat';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n/I18nProvider';

/** Shared by draft thumbnails and sent messages; the caller owns the selected image. */
export function ImagePreview({
  images,
  index,
  onIndexChange,
}: {
  images: readonly ChatImage[];
  index: number | null;
  onIndexChange: (index: number | null) => void;
}) {
  const t = useT();
  const image = index === null ? undefined : images[index];
  const move = (direction: number) => {
    if (index === null || images.length < 2) return;
    onIndexChange((index + direction + images.length) % images.length);
  };

  return (
    <Dialog open={!!image} onOpenChange={(open) => !open && onIndexChange(null)}>
      <DialogContent
        className="flex max-h-[85vh] w-[90vw] max-w-none flex-col gap-3 p-3 pt-10 sm:max-w-none"
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
            return;
          }
          if (images.length < 2 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }}
      >
        <DialogTitle className="sr-only">
          {t('chat.previewImage', { index: (index ?? 0) + 1 })}
        </DialogTitle>
        {image && (
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={t('chat.image', { index: (index ?? 0) + 1 })}
            className="min-h-0 w-full object-contain"
          />
        )}
        {images.length > 1 && (
          <div className="flex shrink-0 items-center justify-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('chat.previousImage')}
              title={t('chat.previousImage')}
              onClick={() => move(-1)}
            >
              <ChevronLeft />
            </Button>
            <span role="status" className="text-muted-foreground text-sm tabular-nums">
              {(index ?? 0) + 1} / {images.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('chat.nextImage')}
              title={t('chat.nextImage')}
              onClick={() => move(1)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
