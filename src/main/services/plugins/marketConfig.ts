/** 插件市场注册表的发布基址（`LAIJiangFeng/fynvra-plugins` 的 dist 分支，契约 v1） */
export const MARKET_BASE_URL =
  'https://raw.githubusercontent.com/LAIJiangFeng/fynvra-plugins/dist/';

/**
 * 验 index.json 签名用的 Ed25519 公钥（SPKI PEM），任意一把通过即可。
 * 对应私钥只存在注册表仓库的 GitHub secret `FYNVRA_INDEX_SIGNING_KEY` 里。
 * 换密钥：先把新公钥加进列表并发布新版 Fynvra，再切换签名私钥，最后移除旧公钥。
 * 列表为空时市场显示「未开放」（configured: false），不发任何网络请求。
 */
export const MARKET_PUBLIC_KEYS: string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAryKTJuWaKsliFptU+oUgmjbojx5JaO+3ULroFUL09iM=
-----END PUBLIC KEY-----
`,
];
