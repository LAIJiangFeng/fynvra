import { Cpu } from 'lucide-react';
import anthropic from '@/assets/model-icons/anthropic.svg';
import deepseek from '@/assets/model-icons/deepseek.svg';
import gemini from '@/assets/model-icons/google-gemini.svg';
import openai from '@/assets/model-icons/openai.svg';
import qwen from '@/assets/model-icons/qwen.svg';
import xai from '@/assets/model-icons/xai.svg';
import glm from '@/assets/model-icons/zai.svg';
import type { ModelBrand } from '@/lib/modelBrand';

const BRAND_ICONS: Record<ModelBrand, string> = { openai, anthropic, xai, gemini, glm, deepseek, qwen };

/** Local SVG masks inherit the text color in both themes; the adjacent model ID is the label. */
export function ModelBrandIcon({ brand }: { brand: ModelBrand | undefined }) {
  if (!brand) return <Cpu aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />;

  return (
    <span
      aria-hidden
      className="size-3.5 shrink-0 bg-current"
      style={{
        maskImage: `url("${BRAND_ICONS[brand]}")`,
        maskSize: 'contain',
        maskPosition: 'center',
        maskRepeat: 'no-repeat',
      }}
    />
  );
}
