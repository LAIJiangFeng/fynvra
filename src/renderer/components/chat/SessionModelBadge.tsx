import type { SessionSummary } from '@shared/types/chat';
import { useT } from '@/i18n/I18nProvider';
import { getModelBrand } from '@/lib/modelBrand';
import { ModelBrandIcon } from './ModelBrandIcon';

/** Use this session's saved reference even when its provider has since been removed. */
export function SessionModelBadge({ model }: { model: SessionSummary['model'] }) {
  const t = useT();
  const modelId = model?.modelId;
  const label = modelId?.trim() ? modelId : t('sessions.modelNotSet');
  const hint = model?.providerId ? `${label}\n${model.providerId}` : label;

  return (
    <span
      className="mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground text-xs"
      title={hint}
    >
      <ModelBrandIcon brand={getModelBrand(modelId)} />
      <span className="sr-only">{t('sessions.model')}: </span>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
