// 渠道附件文档解析的隔离层（ARCHITECTURE §7.12 channel.prompt）：附件来自公开群，属不可信输入。
// 每个非图片文件在新 fork 的独立 utilityProcess 里抽文本（pdf / docx / xlsx / 文本解码，32 MB 文本解码也要数秒）：
// 解压炸弹的内存是 ArrayBuffer（不受 V8 堆上限约束），只有独立进程才能保证 OOM 不波及 Main。
// 环境变量只给白名单；内存看门狗、硬超时；全进程串行排队；超时、超限、崩溃一律记为 unreadable。
import {
  type ChatFileRejection,
  ChatFileTooLargeError,
  type ReadChatFileResult,
  startsWith,
  ZIP_MAGIC,
} from '@shared/chatFileText';
import { unzipSync } from 'fflate/browser';
import { pickPluginEnv } from '../appPlugins/runtime';

/** 单个文件的解析时限 */
export const DOC_FILE_TIMEOUT_MS = 15_000;
/** 子进程内存上限（workingSet 与 privateBytes 取大），超过即 kill */
export const PARSER_MEMORY_LIMIT_MB = 1024;
/** 内存看门狗的查询间隔 */
export const WATCHDOG_INTERVAL_MS = 250;
/** kill 后等子进程退出的上限，保证串行（下一个进程起来时上一个已结束） */
const EXIT_WAIT_MS = 2_000;
/** docx / xlsx 声明的解压后总大小上限与条目数上限 */
export const MAX_ZIP_UNPACKED_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;

/** 解析子进程的最小接口：生产是 utilityProcess（parserProcess.ts），测试用假进程 */
export interface ParserProcess {
  /** 进程起来之前可能是 undefined */
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}
export type ForkParser = (options: {
  env: Record<string, string>;
}) => ParserProcess | Promise<ParserProcess>;
/** 按 pid 查进程内存（KB），查不到返回 undefined */
export type MemoryOfPid = (pid: number) => number | undefined;

export interface IsolationOptions {
  fork?: ForkParser;
  memoryOf?: MemoryOfPid;
  fileTimeoutMs?: number;
  memoryLimitMb?: number;
}

/** 抽一个附件的文本，规则同 extractChatFileText */
export type ExtractChatFile = (name: string, bytes: Uint8Array) => Promise<ReadChatFileResult>;

const REASONS: readonly ChatFileRejection[] = ['unsupported', 'empty', 'unreadable', 'size'];
const unreadable: ReadChatFileResult = { ok: false, reason: 'unreadable' };

/**
 * 只读 zip 中央目录（filter 一律返回 false，不解压）：声明的解压后总大小或条目数超限就抛 ChatFileTooLargeError。
 * 声明值可被伪造，这里只挡明显的炸弹，兜底是子进程的内存看门狗和超时。
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
    // 其他错误（如 fflate 读不了的 zip）交给子进程里的解析器判断
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

/** 收窄子进程回的结果；形状不对的一律 unreadable */
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

/** fork 一个子进程解析一个文件；超时、内存超限、退出都 reject；无论结果如何都 kill 并等它退出后才返回 */
async function runInProcess(
  fork: ForkParser,
  memoryOf: MemoryOfPid,
  memoryLimitMb: number,
  name: string,
  data: Uint8Array,
  timeoutMs: number
): Promise<ReadChatFileResult> {
  // 绝不带 Main 的完整环境：用户环境里可能有 GITHUB / GITLAB token
  const child = await fork({ env: pickPluginEnv(process.env) });
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<ReadChatFileResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('attachment parse timed out')), timeoutMs);
      watchdog = setInterval(() => {
        const pid = child.pid;
        let kb: number | undefined;
        try {
          kb = pid === undefined ? undefined : memoryOf(pid);
        } catch {
          kb = undefined;
        }
        if (kb !== undefined && kb > memoryLimitMb * 1024) {
          reject(new Error('attachment parser exceeded memory limit'));
        }
      }, WATCHDOG_INTERVAL_MS);
      child.onMessage((message) => resolve(toResult(message)));
      child.onExit((code) => {
        markExited();
        reject(new Error(`attachment parser exited (${code})`));
      });
      child.postMessage({ name, data });
    });
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    child.kill();
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise((resolve) => (wait = setTimeout(resolve, EXIT_WAIT_MS))),
    ]);
    clearTimeout(wait);
  }
}

/**
 * 隔离的附件抽取：docx / xlsx 先在 Main 做压缩炸弹预检（不过的记 size），再排进全局串行队列、在新子进程里解析；
 * 单文件时限取 fileTimeoutMs 与距 deadline 剩余时间的较小者；超时、超限、崩溃、排不到队都记 unreadable。
 */
export function isolatedExtractor(
  deadline: number,
  options: IsolationOptions = {}
): ExtractChatFile {
  const { fileTimeoutMs = DOC_FILE_TIMEOUT_MS, memoryLimitMb = PARSER_MEMORY_LIMIT_MB } = options;
  return async (name, bytes) => {
    if (zipBombRejected(name, bytes)) return { ok: false, reason: 'size' };
    try {
      // 未注入时懒加载 Electron 实现：单元测试不加载 electron
      const fork = options.fork ?? (await import('./parserProcess')).forkAttachmentParser;
      const memoryOf = options.memoryOf ?? (await import('./parserProcess')).processMemoryKb;
      return await serial(deadline, (remaining) =>
        runInProcess(fork, memoryOf, memoryLimitMb, name, bytes, Math.min(fileTimeoutMs, remaining))
      );
    } catch {
      return unreadable;
    }
  };
}
