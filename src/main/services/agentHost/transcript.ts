import type { FynvraSessionEventBody } from '@fynvra/core';
import type { ChatMessage, ChatToolCall } from '@shared/types/chat';

const PROMPT_PREVIEW_CHARS = 200;
const ARGS_PREVIEW_CHARS = 200;
const OUTPUT_PREVIEW_CHARS = 300;

/**
 * worker 会话输出的文本投影（launcher.readTranscript → read_worker_output）：assistant 正文原样，
 * 用户消息、工具调用、错误、回合结束各占一行标记。只追加不改写，cursor 是字符偏移，
 * 同一个 Main 进程生命周期内先前的 cursor 一直有效。thinking 与用量不进投影。
 */
export class Transcript {
  #text = '';
  /** 当前 assistant 消息已经收到过 text_delta */
  #streamed = false;

  static fromMessages(messages: readonly ChatMessage[]): Transcript {
    const transcript = new Transcript();
    for (const message of messages) {
      if (message.role === 'user') {
        transcript.#line(`[user] ${oneLine(message.text, PROMPT_PREVIEW_CHARS)}`);
        continue;
      }
      if (message.text) transcript.#line(message.text);
      for (const call of message.toolCalls) {
        transcript.#line(toolStart(call.name, call.args));
        if (call.status !== 'running') {
          transcript.#line(toolEnd(call.name, call.status === 'error', call.output));
        }
      }
    }
    return transcript;
  }

  get length(): number {
    return this.#text.length;
  }

  read(cursor: number): { text: string; total: number } {
    const start = Number.isFinite(cursor)
      ? Math.min(Math.max(0, Math.floor(cursor)), this.length)
      : 0;
    return { text: this.#text.slice(start), total: this.length };
  }

  append(event: FynvraSessionEventBody): void {
    switch (event.type) {
      case 'text_delta':
        this.#text += event.delta;
        this.#streamed = true;
        return;
      case 'message_end':
        if (event.role === 'user') {
          this.#line(`[user] ${oneLine(event.text, PROMPT_PREVIEW_CHARS)}`);
          return;
        }
        if (!this.#streamed && event.text) this.#text += event.text;
        this.#streamed = false;
        this.#endLine();
        return;
      case 'tool_start':
        this.#line(toolStart(event.toolName, event.args));
        return;
      case 'tool_end':
        this.#line(toolEnd(event.toolName, event.isError, event.output));
        return;
      case 'approval_request':
        this.#line(`[approval] ${event.toolName}`);
        return;
      case 'error':
        this.#line(`[error] ${event.message}`);
        return;
      case 'agent_settled':
        this.#line(event.aborted ? '[aborted]' : '[settled]');
        return;
      default:
        return;
    }
  }

  #endLine(): void {
    if (this.#text && !this.#text.endsWith('\n')) this.#text += '\n';
  }

  #line(text: string): void {
    this.#endLine();
    this.#text += `${text}\n`;
  }
}

function toolStart(name: string, args: unknown): string {
  const preview = oneLine(stringify(args), ARGS_PREVIEW_CHARS);
  return preview ? `[tool] ${name} ${preview}` : `[tool] ${name}`;
}

function toolEnd(name: string, isError: boolean, output: ChatToolCall['output']): string {
  const preview = oneLine(output ?? '', OUTPUT_PREVIEW_CHARS);
  return `[tool ${isError ? 'error' : 'done'}] ${name}${preview ? `: ${preview}` : ''}`;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
