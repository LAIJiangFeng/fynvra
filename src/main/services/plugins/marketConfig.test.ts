import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyIndexSignature } from './market';
import { MARKET_PUBLIC_KEYS } from './marketConfig';

// 真实快照：fynvra-plugins dist 分支 83d0d692c95092d938e8ee09b36baea8f519f4f7 的原始字节（base64 内嵌，避免格式化或换行转换改动字节）
const INDEX_B64 = [
  'ewogICJzY2hlbWFWZXJzaW9uIjogMSwKICAic2VxdWVuY2UiOiAxNzk1MzM2MjEwLAogICJnZW5lcmF0ZWRBdCI6ICIyMDI2',
  'LTExLTIyVDA4OjMwOjEwLjUyOVoiLAogICJwbHVnaW5zIjogWwogICAgewogICAgICAiaWQiOiAiY29tLmZ5bnZyYS50ZWxl',
  'Z3JhbSIsCiAgICAgICJuYW1lIjogIlRlbGVncmFtIOe+pOWPjemmiOWAvOePrSIsCiAgICAgICJkZXNjcmlwdGlvbiI6ICLl',
  'nKggVGVsZWdyYW0g576k6YeMIEDmnLrlmajkurog5Y+N6aaI6Zeu6aKY77ya6Ieq5Yqo5YiG6K+K44CB6L+96Zeu77yM5a6a',
  '5L2N5Yiw5Y6f5Zug55qEIGJ1ZyDnlLHlgLznj63kvJror53kv67lpI3lubblvIAgUFLvvIzmlrDlip/og73pnIDkvaDlnKjo',
  'rr7nva7pobXph4fnurPjgILnvqTlm57lpI3lhYjnu4/ov4cgRnludnJhIOeahOWHuuermei/h+a7pOOAgiIsCiAgICAgICJh',
  'dXRob3IiOiAiRnludnJhIiwKICAgICAgImhvbWVwYWdlIjogImh0dHBzOi8vZ2l0aHViLmNvbS9MQUlKaWFuZ0ZlbmcvZnlu',
  'dnJhLXBsdWdpbnMvdHJlZS9tYWluL29mZmljaWFsL2NvbS5meW52cmEudGVsZWdyYW0iLAogICAgICAicmVwb3NpdG9yeSI6',
  'ICJodHRwczovL2dpdGh1Yi5jb20vTEFJSmlhbmdGZW5nL2Z5bnZyYS1wbHVnaW5zIiwKICAgICAgImxpY2Vuc2UiOiAiQXBh',
  'Y2hlLTIuMCIsCiAgICAgICJjYXRlZ29yeSI6ICJpbnRlZ3JhdGlvbiIsCiAgICAgICJ0YWdzIjogWwogICAgICAgICJ0ZWxl',
  'Z3JhbSIsCiAgICAgICAgImZlZWRiYWNrIiwKICAgICAgICAib2ZmaWNpYWwiCiAgICAgIF0sCiAgICAgICJ0aWVyIjogIm9m',
  'ZmljaWFsIiwKICAgICAgImtpbmQiOiAiZnludnJhIiwKICAgICAgInZlcnNpb25zIjogWwogICAgICAgIHsKICAgICAgICAg',
  'ICJ2ZXJzaW9uIjogIjAuMS4zIiwKICAgICAgICAgICJlbmdpbmVzIjogewogICAgICAgICAgICAiZnludnJhIjogIj49MC4x',
  'LjAiCiAgICAgICAgICB9LAogICAgICAgICAgImNvbW1pdCI6ICJjYmJlOGVmZDBiM2Q0ZGI1ZjlkMjUxZjAyYTg4MDRhYTgz',
  'N2VlZTVhIiwKICAgICAgICAgICJwZXJtaXNzaW9ucyI6IFsKICAgICAgICAgICAgIm5vdGlmaWNhdGlvbnMiLAogICAgICAg',
  'ICAgICAibmV0d29yayIsCiAgICAgICAgICAgICJ3b3Jrc3BhY2VzIiwKICAgICAgICAgICAgImNoYW5uZWwiLAogICAgICAg',
  'ICAgICAidWkiCiAgICAgICAgICBdLAogICAgICAgICAgImNoYW5nZWxvZyI6ICLpppbkuKrlhazlvIDniYjmnKzvvJrnvqTp',
  'h4wgQOacuuWZqOS6uiDlj43ppojpl67popjvvIzoh6rliqjliIbor4rkuI7ov73pl67vvJvmlK/mjIHlm77niYflkozmlofm',
  'oaPvvIjlhYjlj5Hlm77lho0gQOOAgeWFiCBAIOWGjeWPkeWbvuS5n+iDveivhuWIq++8ie+8m+WumuS9jeWIsOWOn+WboOea',
  'hCBidWcg55Sx5YC854+t5Lya6K+d5L+u5aSN5bm25byAIFBS77yM5paw5Yqf6IO96ZyA5Zyo6K6+572u6aG16YeH57qz77yb',
  '576k5Zue5aSN5YWI57uP6L+H5Ye656uZ6L+H5ruk44CCIiwKICAgICAgICAgICJwdWJsaXNoZWRBdCI6ICIyMDI2LTExLTIy',
  'VDA4OjMwOjEwLjUyOVoiLAogICAgICAgICAgInBhY2thZ2UiOiB7CiAgICAgICAgICAgICJwYXRoIjogInBhY2thZ2VzL2Nv',
  'bS5meW52cmEudGVsZWdyYW0vMC4xLjMuemlwIiwKICAgICAgICAgICAgInNoYTI1NiI6ICIyYzdjYjJlNzU4NzUxOTJlNTc1',
  'YzAxYTg2ZWRhY2M1ZmJjNDQ1NTJhYTNiOGFhMTk4NzU2OTY2Yzk0NGRkMjFlIiwKICAgICAgICAgICAgInNpemUiOiAxMDAz',
  'MjgKICAgICAgICAgIH0sCiAgICAgICAgICAicmVhZG1lIjogewogICAgICAgICAgICAicGF0aCI6ICJyZWFkbWUvY29tLmZ5',
  'bnZyYS50ZWxlZ3JhbS8wLjEuMy5tZCIsCiAgICAgICAgICAgICJzaGEyNTYiOiAiNDkzMDIxNTZkYjljOGY2MzkyZmE5ZGVm',
  'NmI2ODVlNjQ1ODI3ZjdmYzdmMmM2MzcyZmY4MWNhM2YyMjQ2Y2UyOCIsCiAgICAgICAgICAgICJzaXplIjogODMzNAogICAg',
  'ICAgICAgfQogICAgICAgIH0KICAgICAgXQogICAgfQogIF0sCiAgInJldm9rZWQiOiBbXQp9Cg==',
].join('');
const SIG_B64 =
  'NlFZMmNBYjI3Z2tWNDRDYzlLZTl2NFVHZVU4RnJFZ0RNdndLOHpjNGZvK2Q5UEZrYU92bXJlRVpydEpCdGlDTE1KSWk0b3AxR05kWUYwd3lHb0dLQ3c9PQo=';

const index = Buffer.from(INDEX_B64, 'base64');
const signature = Buffer.from(SIG_B64, 'base64').toString('utf8');

describe('MARKET_PUBLIC_KEYS', () => {
  it('非空，且每一把都是 Ed25519 公钥', () => {
    expect(MARKET_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const pem of MARKET_PUBLIC_KEYS) {
      expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519');
    }
  });

  it('真实 dist 快照验签通过', () => {
    expect(verifyIndexSignature(index, signature, MARKET_PUBLIC_KEYS)).toBe(true);
  });

  it('快照改掉一个字节后验签失败', () => {
    const tampered = Buffer.from(index);
    tampered[0] ^= 1;
    expect(verifyIndexSignature(tampered, signature, MARKET_PUBLIC_KEYS)).toBe(false);
  });
});
