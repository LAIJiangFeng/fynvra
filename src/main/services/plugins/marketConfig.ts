/** 插件市场注册表的发布基址（`LAIJiangFeng/fynvra-plugins` 的 dist 分支，契约 v1） */
export const MARKET_BASE_URL =
  'https://raw.githubusercontent.com/LAIJiangFeng/fynvra-plugins/dist/';

/**
 * 验 index.json 签名用的 Ed25519 公钥（SPKI PEM），任意一把通过即可。
 * 维护者在注册表仓库运行 `gen-key.mjs` 生成密钥对后，把公钥 PEM 填到这里（私钥只放 CI secret）。
 * 为空时市场显示「未配置」（configured: false），不发任何网络请求。
 */
export const MARKET_PUBLIC_KEYS: string[] = [];
