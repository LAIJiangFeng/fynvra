import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { parseMaxOutputLimit } from '@shared/maxOutputLimit';

type StreamFn = AgentSession['agent']['streamFunction'];
type StreamOptions = Parameters<StreamFn>[2];

/**
 * 端点拒绝 max_tokens（如智谱 GLM：`max_tokens参数非法：限制数值范围[1,131072]`）时的安全网：
 * 在 agent 的 streamFunction 外再包一层。请求还没流出任何内容就以这种报错结束时，把这个模型的 maxTokens
 * 降到端点报的上限（不超过窗口），同一请求静默重发一次；pi 只看到重发的结果，失败的那次不进 jsonl、不发事件。
 * 重发也失败时照常交给 pi。之后本会话对这个模型的请求都按降低后的上限发；onLearned 在降低时调用。
 */
export function installMaxTokensRetry(
  agent: { streamFunction: StreamFn },
  onLearned: (model: Model<Api>, maxOutput: number) => void
): void {
  const inner = agent.streamFunction;
  /** `provider\nid` → 端点允许的最大输出 */
  const caps = new Map<string, number>();
  const keyOf = (model: Model<Api>) => `${model.provider}\n${model.id}`;

  agent.streamFunction = async (model, context, options) => {
    const cap = caps.get(keyOf(model));
    const request = cap === undefined ? model : withCap(model, cap);
    const requestOptions = cap === undefined ? options : optionsWithCap(options, cap);
    const first = await inner(request, context, requestOptions);
    const out = createAssistantMessageEventStream();

    async function forward(): Promise<void> {
      // 还没有内容时先扣住 start，看第一条实质事件是不是 max_tokens 超范围
      const held: AssistantMessageEvent[] = [];
      let buffering = true;
      let terminal = false;
      for await (const event of first) {
        if (buffering) {
          if (event.type === 'start') {
            held.push(event);
            continue;
          }
          const limit =
            event.type === 'error' && event.reason === 'error' && !options?.signal?.aborted
              ? retryLimit(event.error, request, requestOptions)
              : undefined;
          if (limit !== undefined) {
            const retried = await retry(limit);
            if (retried) {
              await pipe(retried, out);
              return;
            }
          }
          buffering = false;
          for (const pending of held) out.push(pending);
        }
        out.push(event);
        terminal = event.type === 'done' || event.type === 'error';
      }
      if (buffering) for (const pending of held) out.push(pending);
      if (!terminal) out.end(await first.result());
    }

    async function retry(limit: number): Promise<AssistantMessageEventStream | undefined> {
      caps.set(keyOf(model), limit);
      try {
        onLearned(model, limit);
      } catch {
        // 通知失败不影响重发
      }
      try {
        return await inner(withCap(request, limit), context, optionsWithCap(requestOptions, limit));
      } catch {
        // StreamFn 不该抛错；万一抛了，就把原来的报错交给 pi
        return undefined;
      }
    }

    void forward().catch(() => out.end());
    return out;
  };
}

/** 端点报的上限比这次请求的 max_tokens 小时才值得重发（报的上限不比请求小，说明不是这个原因） */
function retryLimit(
  error: AssistantMessage,
  model: Model<Api>,
  options: StreamOptions
): number | undefined {
  const limit = parseMaxOutputLimit(error.errorMessage ?? '');
  if (limit === undefined) return undefined;
  const capped = model.contextWindow > 0 ? Math.min(limit, model.contextWindow) : limit;
  return capped < (options?.maxTokens ?? model.maxTokens) ? capped : undefined;
}

function withCap(model: Model<Api>, cap: number): Model<Api> {
  return model.maxTokens > cap ? { ...model, maxTokens: cap } : model;
}

function optionsWithCap(options: StreamOptions, cap: number): StreamOptions {
  return options?.maxTokens !== undefined && options.maxTokens > cap
    ? { ...options, maxTokens: cap }
    : options;
}

async function pipe(
  source: AssistantMessageEventStream,
  out: AssistantMessageEventStream
): Promise<void> {
  let terminal = false;
  for await (const event of source) {
    out.push(event);
    terminal = event.type === 'done' || event.type === 'error';
  }
  if (!terminal) out.end(await source.result());
}
