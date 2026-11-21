// 附件解析 worker 线程入口：Main 经 `?nodeWorker` 为每个文件起一个，收一条 { name, data }，
// 按输入框同一套规则（extractChatFileText：pdf / docx / xlsx / 文本解码）回一条结果后由 Main 终止。
import { parentPort } from 'node:worker_threads';
import { extractChatFileText } from '@shared/chatFileText';
import { MAIN_EXTRACTORS } from './extractors';

parentPort?.once('message', async (message: { name: unknown; data: unknown }) => {
  const { name, data } = message;
  if (typeof name !== 'string' || !(data instanceof Uint8Array)) {
    parentPort?.postMessage({ ok: false, reason: 'unreadable' });
    return;
  }
  parentPort?.postMessage(await extractChatFileText(name, data, MAIN_EXTRACTORS));
});
