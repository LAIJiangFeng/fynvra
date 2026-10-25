import { describe, expect, it } from 'vitest';
import { updateUnavailableReason } from './platform';

describe('自动更新支持的平台', () => {
  it('正式版支持 Windows x64 和 Mac Intel / Apple Silicon', () => {
    for (const [platform, arch] of [
      ['win32', 'x64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
    ]) {
      expect(updateUnavailableReason(true, platform, arch)).toBeUndefined();
    }
  });
  it('开发环境仍禁用更新，未发布的平台不会请求不匹配的安装包', () => {
    expect(updateUnavailableReason(false, 'darwin', 'arm64')).toBe('development');
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'ia32'],
    ]) {
      expect(updateUnavailableReason(true, platform, arch)).toBe('unsupported');
    }
  });
});
