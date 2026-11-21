// 渠道附件文档解析的隔离层（ARCHITECTURE §7.12 channel.prompt）：附件来自公开群，属不可信输入。
// 每个非图片文件在新起的 worker 线程里抽文本（pdf / docx / xlsx / 文本解码，32 MB 文本解码也要数秒），
// 有内存上限和硬超时；全进程串行排队；超时、崩溃一律记为 unreadable。
import type { Worker, WorkerOptions } from 'node:worker_threads';
import {
  type ChatFileRejection,
  ChatFileTooLargeError,
  type ReadChatFileResult,
  startsWith,
  ZIP_MAGIC,
} from '@shared/chatFileText';
import { unzipSync } from 'fflate/browser';

/** 单个文件的解析时限 */
export const DOC_FILE_TIMEOUT_MS = 15_000;
/** worker 的 V8 老生代上限 */
export const DOC_WORKER_MEMORY_MB = 512;
/** docx / xlsx 声明的解压后总大小上限与条目数上限 */
export const MAX_ZIP_UNPACKED_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;

export type SpawnDocWorker = (options: WorkerOptions) => Worker | Promise<Worker>;
/** 抽一个附件的文本，规则同 extractChatFileText */
export type ExtractChatFile = (name: string, bytes: Uint8Array) => Promise<ReadChatFileResult>;

const REASONS: readonly ChatFileRejection[] = ['unsupported', 'empty', 'unreadable', 'size'];
const unreadable: ReadChatFileResult = { ok: false, reason: 'unreadable' };

const spawnBuilt: SpawnDocWorker = async (options) => {
  // 懒加载：electron-vite 把 docWorker.ts 单独打成 chunk，这里拿到起 worker 的函数
  const { default: createWorker } = await import('./docWorker?nodeWorker');
  return createWorker(options);
};

/**
 * 只读 zip 中央目录（filter 一律返回 false，不解压）：声明的解压后总大小或条目数超限就抛 ChatFileTooLargeError。
 * 声明值可被伪造，这里只挡明显的炸弹，兜底是 worker 的内存上限和超时。
 */
export function checkZipBomb(data: Uint8Array): void {
  let entries = 0;
  let unpacked = 0;
  unzipSync(data, {
    filter: (file) => {
      entries++;
      unpacked += file.originalSize;
      if (entries > MAX_ZIP_ENTRIES || unpacked > MAX_ZIP_UNPACKED_BYTES) {
        throw new ChatFileTooLargeError();
      }
      return false;
    },
  });
}

/** 与 extractChatFileText 的分派一致：会交给 docx / xlsx 解析器的文件先做炸弹预检 */
function zipBombRejected(name: string, bytes: Uint8Array): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if ((ext !== 'docx' && ext !== 'xlsx') || !startsWith(bytes, ZIP_MAGIC)) return false;
  try {
    checkZipBomb(bytes);
    return false;
  } catch (error) {
    // 其他错误（如 fflate 读不了的 zip）交给 worker 里的解析器判断
    return error instanceof ChatFileTooLargeError;
  }
}

// 全进程共用的串行队列尾：同一时刻最多一个解析在跑
let tail: Promise<void> = Promise.resolve();

/** 排队等前一个解析结束再跑 job；等到 deadline 仍没轮到就放弃（不跑），但仍保持队列顺序 */
function serial<T>(deadline: number, job: (remainingMs: number) => Promise<T>): Promise<T> {
  const prev = tail;
  let release!: () => void;
  tail = new Promise((resolve) => {
    release = resolve;
  });
  return (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const turn = await Promise.race([
        prev.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      const remaining = deadline - Date.now();
      if (!turn || remaining <= 0) throw new Error('attachment budget exhausted');
      return await job(remaining);
    } finally {
      clearTimeout(timer);
      // 放弃排队时 prev 可能还在跑：等它结束再放行下一个
      void prev.then(release);
    }
  })();
}

/** 收窄 worker 回的结果；形状不对的一律 unreadable */
function toResult(message: unknown): ReadChatFileResult {
  const m = (message ?? {}) as { ok?: unknown; reason?: unknown; file?: unknown };
  if (m.ok === false && REASONS.includes(m.reason as ChatFileRejection)) {
    return { ok: false, reason: m.reason as ChatFileRejection };
  }
  const file = (m.file ?? {}) as { name?: unknown; text?: unknown };
  if (m.ok === true && typeof file.name === 'string' && typeof file.text === 'string') {
    return { ok: true, file: { name: file.name, text: file.text } };
  }
  return unreadable;
}

/** 起一个 worker 解析一个文件；超时、出错、退出都 reject；无论结果如何都等 worker 终止后才返回 */
async function runInWorker(
  spawn: SpawnDocWorker,
  name: string,
  data: Uint8Array,
  timeoutMs: number
): Promise<ReadChatFileResult> {
  const worker = await spawn({ resourceLimits: { maxOldGenerationSizeMb: DOC_WORKER_MEMORY_MB } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ReadChatFileResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('attachment parse timed out')), timeoutMs);
      worker.once('message', (message: unknown) => resolve(toResult(message)));
      // 内存超限（ERR_WORKER_OUT_OF_MEMORY）与未捕获异常走 error，自行退出走 exit
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`attachment worker exited (${code})`)));
      worker.postMessage({ name, data });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

/**
 * 隔离的附件抽取：docx / xlsx 先在 Main 做压缩炸弹预检（不过的记 size），再排进全局串行队列、在新 worker 里解析；
 * 单文件时限取 fileTimeoutMs 与距 deadline 剩余时间的较小者；超时、崩溃、排不到队都记 unreadable。
 */
export function isolatedExtractor(
  deadline: number,
  spawn: SpawnDocWorker = spawnBuilt,
  fileTimeoutMs = DOC_FILE_TIMEOUT_MS
): ExtractChatFile {
  return async (name, bytes) => {
    if (zipBombRejected(name, bytes)) return { ok: false, reason: 'size' };
    try {
      return await serial(deadline, (remaining) =>
        runInWorker(spawn, name, bytes, Math.min(fileTimeoutMs, remaining))
      );
    } catch {
      return unreadable;
    }
  };
}
