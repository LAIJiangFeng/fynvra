import feishu from '@/assets/plugin-icons/feishu.svg';
import telegram from '@/assets/plugin-icons/telegram.svg';

// 只有官方插件用品牌图标，其余插件用通用图标
const BRAND_LOGOS = new Map<string, string>([
  ['com.fynvra.feishu', feishu],
  ['com.fynvra.telegram', telegram],
]);

/** 按插件 id 取品牌图标地址，没有返回 undefined */
export function pluginBrandLogo(id: string): string | undefined {
  return BRAND_LOGOS.get(id);
}
