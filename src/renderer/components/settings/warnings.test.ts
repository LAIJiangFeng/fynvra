import { describe, expect, it } from 'vitest';
import { warningLine } from './warnings';

// 样本取自 Main 的导入扫描与拉取模型列表实际给出的告警
describe('warningLine', () => {
  it('drops the follow-up at the end, keeping 「来源 · 名称：原因」', () => {
    expect(warningLine('Claude Code · pencil：没有命令或 URL，已跳过')).toBe(
      'Claude Code · pencil：没有命令或 URL'
    );
    expect(warningLine('Codex：~/.codex/config.toml 第 3 行不是有效的 TOML，已跳过')).toBe(
      'Codex：~/.codex/config.toml 第 3 行不是有效的 TOML'
    );
    expect(warningLine('Codex：~/.codex/auth.json 不是有效的 JSON，已忽略其中的 key')).toBe(
      'Codex：~/.codex/auth.json 不是有效的 JSON'
    );
  });

  it('drops suggestions about what to do after importing', () => {
    expect(
      warningLine('Codex · github：环境变量 GITHUB_TOKEN、API_KEY 没有设置，导入后需要在编辑里补上')
    ).toBe('Codex · github：环境变量 GITHUB_TOKEN、API_KEY 没有设置');
    expect(
      warningLine(
        'CC Switch · 公司中转：环境变量 OPENAI_KEY 没有设置，导入后需要在编辑里填写 API Key'
      )
    ).toBe('CC Switch · 公司中转：环境变量 OPENAI_KEY 没有设置');
    // 两段后续：从第一段起都去掉
    expect(
      warningLine(
        'Cursor · figma：环境变量 TOKEN、Header Authorization 引用了变量，fynvra 不会展开，导入后请在编辑里改成实际值'
      )
    ).toBe('Cursor · figma：环境变量 TOKEN、Header Authorization 引用了变量');
  });

  it('shortens the notes of the remote model list the same way', () => {
    expect(warningLine('GET /v1/models 不可用（HTTP 404），已改用 GET /models')).toBe(
      'GET /v1/models 不可用（HTTP 404）'
    );
    expect(warningLine('2 个条目没有有效的模型 id，已跳过')).toBe('2 个条目没有有效的模型 id');
    expect(warningLine('服务端还有更多模型没有返回，这里只列出了第一页')).toBe(
      '服务端还有更多模型没有返回'
    );
  });

  it('keeps warnings without a follow-up as they are, commas in the reason included', () => {
    for (const warning of [
      'Claude Code：读取失败（EACCES，permission denied）',
      '模型太多，只列出前 2000 个',
      '已略过 3 个不支持 generateContent 的模型（如嵌入、图像模型）',
    ]) {
      expect(warningLine(warning)).toBe(warning);
    }
  });

  it('never shortens a warning to nothing', () => {
    expect(warningLine('，已跳过')).toBe('，已跳过');
  });
});
