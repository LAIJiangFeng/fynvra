import type { InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * 把一段文本追加到系统提示词的 append 段。
 * before_agent_start 每次 run 都触发，按内容去重，保证只出现一次。
 *
 * `text` 也可以是函数：每次 run 开始时调用，返回空（undefined / ''）时这次 run 不追加。
 * 不追加的 run 里这段文本也不会残留，无需移除：pi 1.4.0 的 `emitBeforeAgentStart` 每次 run 都用
 * `normalizeBuildSystemPromptOptions` 从会话的 `_baseSystemPromptOptions` 复制一份新的 options 交给处理器，
 * run 结束时丢弃（`_runSystemPromptOptions = undefined`）；系统提示词的 addendum 段按 run 整段比对替换。
 *
 * 升级复检点：依赖 pi 1.4.0 before_agent_start 事件上可变的
 * `systemPromptOptions.appendSystemPrompt`（NormalizedBuildSystemPromptOptions），且每次 run 都是新副本。
 */
export function appendSystemPromptExtension(
  name: string,
  text: string | (() => string | undefined)
): InlineExtension {
  const read = typeof text === 'function' ? text : () => text;
  return {
    name,
    hidden: true,
    factory: (pi) => {
      pi.on('before_agent_start', (event) => {
        const append = read();
        if (!append) return;
        const options = event.systemPromptOptions;
        const current = options.appendSystemPrompt ?? '';
        if (current.includes(append)) return;
        options.appendSystemPrompt = current ? `${current}\n\n${append}` : append;
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
