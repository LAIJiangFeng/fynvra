import type { InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * 把一段文本追加到系统提示词的 append 段（EnsoCode `appendSystemPromptExtension` 同款）。
 * before_agent_start 每次 run 都触发，按内容去重，保证只出现一次。
 *
 * 升级复检点：依赖 pi 1.4.0 before_agent_start 事件上可变的
 * `systemPromptOptions.appendSystemPrompt`（NormalizedBuildSystemPromptOptions）。
 */
export function appendSystemPromptExtension(name: string, text: string): InlineExtension {
  return {
    name,
    hidden: true,
    factory: (pi) => {
      pi.on('before_agent_start', (event) => {
        const options = event.systemPromptOptions;
        const current = options.appendSystemPrompt ?? '';
        if (current.includes(text)) return;
        options.appendSystemPrompt = current ? `${current}\n\n${text}` : text;
      });
    },
  };
}

/**
 * 每次 agent run 开始前回调（新 prompt 或触发 turn 的自定义消息）。
 *
 * 升级复检点：依赖 before_agent_start 在每个 run 开始前恰好触发一次。
 */
export function beforeRunExtension(name: string, onRun: () => void): InlineExtension {
  return {
    name,
    hidden: true,
    factory: (pi) => {
      pi.on('before_agent_start', () => {
        onRun();
      });
    },
  };
}
