import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export interface ToolRun {
  /** 失败发生在 schema 校验（pi 不会调用 execute）还是 execute 里 */
  stage: 'validate' | 'execute';
  text: string;
  isError: boolean;
  details?: unknown;
  terminate?: boolean;
}

type AnyTool = ToolDefinition<any, any>;

/** 按 pi agent loop 的顺序执行一次工具调用：prepareArguments → schema 校验 → execute */
export async function runTool(
  tool: AnyTool,
  args: unknown,
  signal?: AbortSignal
): Promise<ToolRun> {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  let validated: unknown;
  try {
    validated = validateToolArguments(tool as never, {
      type: 'toolCall',
      id: 'call-1',
      name: tool.name,
      arguments: prepared as never,
    });
  } catch (error) {
    return {
      stage: 'validate',
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
  const result = await tool.execute('call-1', validated as never, signal, undefined, {} as never);
  return {
    stage: 'execute',
    text: result.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    isError: result.isError === true,
    details: result.details,
    ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
  };
}

export function toolByName(tools: readonly AnyTool[], name: string): AnyTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not found in [${tools.map((t) => t.name).join(', ')}]`);
  return tool;
}
