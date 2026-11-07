import { BlockList, isIP } from 'node:net';

/** URL 长度上限（字符） */
export const WEB_URL_MAX_CHARS = 2048;

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/**
 * 被拦截的地址：回环、私网、链路本地（含云元数据 169.254.169.254）、CGNAT、组播、保留。
 * 198.18.0.0/15 不在其中：Clash / Surge 的 fake-ip 默认用这个网段，拦截后 TUN 模式下所有网站都会失败。
 */
const BLOCKED = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  list.addAddress('::', 'ipv6');
  list.addAddress('::1', 'ipv6');
  for (const [network, prefix] of [
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
})();

/** 地址（IPv4 或 IPv6 字面量，可带 IPv6 zone）是否被拦截；不是 IP 的一律视为拦截 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family !== 6) return true;
  if (BLOCKED.check(ip, 'ipv6')) return true;
  const embedded = embeddedIpv4(ip);
  return embedded !== undefined && BLOCKED.check(embedded, 'ipv4');
}

/**
 * 内嵌 IPv4：`::ffff:0:0/96`（映射）、`::/96`（兼容，已废弃）、`64:ff9b::/96`（NAT64）取末 32 位，
 * `2002::/16`（6to4）取第 16–48 位。
 */
function embeddedIpv4(ip: string): string | undefined {
  const groups = expandIpv6(ip);
  if (!groups) return undefined;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const toIpv4 = (high: number, low: number) =>
    [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  if (zeros(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) {
    return toIpv4(groups[6] as number, groups[7] as number);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) {
    return toIpv4(groups[6] as number, groups[7] as number);
  }
  if (groups[0] === 0x2002) return toIpv4(groups[1] as number, groups[2] as number);
  return undefined;
}

/** IPv6 字面量 → 8 个 16 位分组；末尾可为点分 IPv4 */
function expandIpv6(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined) =>
    part ? part.split(':').map((group) => Number.parseInt(group, 16)) : [];
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return undefined;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return undefined;
  return groups;
}

/**
 * 校验要抓取的 URL（每一跳重定向都要再校验）：只接受 http/https、≤ 2048 字符、不含用户名密码；
 * 拒绝 localhost、*.localhost、不含点的单标签主机名（IP 字面量除外）与被拦截的 IP 字面量。
 * WHATWG URL 会把十进制、十六进制等 IPv4 写法规范成点分形式。
 */
export function checkUrl(raw: string): UrlCheck {
  const fail = (error: string): UrlCheck => ({ ok: false, error });
  if (raw.length > WEB_URL_MAX_CHARS) {
    return fail(`the URL is longer than ${WEB_URL_MAX_CHARS} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('the URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail(`only http and https URLs are supported, not ${url.protocol.replace(/:$/, '')}`);
  }
  if (url.username || url.password) return fail('URLs with a user name or password are refused');
  if (url.href.length > WEB_URL_MAX_CHARS) {
    return fail(`the URL is longer than ${WEB_URL_MAX_CHARS} characters`);
  }
  const host = hostOf(url);
  if (!host) return fail('the URL has no host');
  if (isIP(host)) {
    return isBlockedAddress(host)
      ? fail(`${host} is a local, private or reserved address and cannot be fetched`)
      : { ok: true, url };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return fail(`${host} is a local host name and cannot be fetched`);
  }
  if (!host.includes('.')) {
    return fail(`${host} is a single-label (intranet) host name and cannot be fetched`);
  }
  return { ok: true, url };
}

/** 主机名：去掉 IPv6 的方括号和末尾的点 */
export function hostOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}
