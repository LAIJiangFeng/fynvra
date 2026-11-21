/**
 * 渠道附件解析子进程入口，跑在 Electron utilityProcess 里（Main 经 `?modulePath` 单独构建后为每个文件 fork 一个）。
 * 收一条 { name, data }，按输入框同一套规则（extractChatFileText：pdf / docx / xlsx / 文本解码）回一条结果，随后由 Main 结束进程。
 * 本文件不 import electron；与 Main 的通道是 Electron 注入的 `process.parentPort`。
 */
import { extractChatFileText } from '@shared/chatFileText';
import { MAIN_EXTRACTORS } from './extractors';

interface ParentPort {
  once(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error('attachmentParser must run in an Electron utilityProcess');

port.once('message', async (event) => {
  const { name, data } = (event.data ?? {}) as { name?: unknown; data?: unknown };
  if (typeof name !== 'string' || !(data instanceof Uint8Array)) {
    port.postMessage({ ok: false, reason: 'unreadable' });
    return;
  }
  port.postMessage(await extractChatFileText(name, data, MAIN_EXTRACTORS));
});
