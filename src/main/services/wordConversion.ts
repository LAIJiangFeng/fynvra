import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

/** 与 files.ts 的文档预览上限一致。 */
const MAX_DOCX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_FILES = 64;
const CACHE_MAX_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 90_000;
const PK_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CACHE_NAME = /^[0-9a-f]{64}\.docx$/;

/** 退出码约定：0 成功；2 打开或保存失败；3 Word 不可用；4 缺少参数；5 无法禁用宏。 */
const EXIT_UNAVAILABLE = 3;

/**
 * 常量脚本：路径只经环境变量传入，不拼进脚本文本。
 * 宏禁用失败即退出；不改任何 Options.*（会持久化到用户 Word 配置）。
 * 每次转换写到临时目录后以 -File 执行（不用 -EncodedCommand，便于审计、避免 EDR 误报）。
 * 装有 Office PIA 时 PowerShell 按 interop 类型绑定，ByRef 参数可能报 PSReference 错误：
 * 非 COM 异常（参数绑定类）时改用 IDispatch 晚绑定 InvokeMember 重试。
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
function Test-BindingError($record) {
  $inner = $record.Exception
  while ($inner.InnerException) { $inner = $inner.InnerException }
  return -not ($inner -is [System.Runtime.InteropServices.COMException])
}
function Invoke-Com($target, [string]$name, [object[]]$arguments, [scriptblock]$direct) {
  try {
    return & $direct
  } catch {
    if (-not (Test-BindingError $_)) { throw }
    return [System.__ComObject].InvokeMember($name, [System.Reflection.BindingFlags]::InvokeMethod, $null, $target, $arguments)
  }
}
$source = $env:FYNVRA_DOC_SOURCE
$target = $env:FYNVRA_DOC_TARGET
if (-not $source -or -not $target) { exit 4 }
$before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
try {
  $word = New-Object -ComObject Word.Application
} catch {
  exit 3
}
$code = 2
$doc = $null
$own = $false
try {
  $new = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
  if ($new.Count -eq 1) {
    $own = $true
    [Console]::Out.WriteLine("PID:$($new[0])")
    [Console]::Out.Flush()
  }
  try {
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.ScreenUpdating = $false
  } catch {}
  try {
    $word.AutomationSecurity = 3
    if ($word.AutomationSecurity -ne 3) { throw 'macro' }
  } catch {
    $code = 5
    throw
  }
  $m = [Type]::Missing
  $password = 'fynvra-no-password'
  $docs = $word.Documents
  $openArgs = [object[]]@($source, $false, $true, $false, $password, $password, $false, $m, $m, $m, $m, $false, $false, $m, $true)
  $doc = Invoke-Com $docs 'Open' $openArgs { $docs.Open($source, $false, $true, $false, $password, $password, $false, $m, $m, $m, $m, $false, $false, $m, $true) }
  if ($doc -eq $null) { throw 'open' }
  [void](Invoke-Com $doc 'SaveAs2' ([object[]]@($target, 12)) { $doc.SaveAs2($target, 12) })
  [void](Invoke-Com $doc 'Close' ([object[]]@(0)) { $doc.Close(0) })
  $doc = $null
  $code = 0
} catch {
} finally {
  if ($doc -ne $null) { try { [void](Invoke-Com $doc 'Close' ([object[]]@(0)) { $doc.Close(0) }) } catch {} }
  try {
    if ($own -or $word.Documents.Count -eq 0) { [void](Invoke-Com $word 'Quit' ([object[]]@(0)) { $word.Quit(0) }) }
  } catch {}
  try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch {}
  $word = $null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
exit $code
`;

export type WordConversionResult =
  | { ok: true; docx: Buffer }
  | { ok: false; reason: 'unavailable' | 'failed' | 'timeout' | 'tooLarge' };

type Failure = Extract<WordConversionResult, { ok: false }>;

function systemRoot(): string {
  return process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
}

function taskkill(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      join(systemRoot(), 'System32', 'taskkill.exe'),
      args,
      { windowsHide: true, timeout: 10_000 },
      () => resolve()
    );
  });
}

function hasDocxMagic(bytes: Buffer): boolean {
  return bytes.length >= PK_MAGIC.length && bytes.subarray(0, PK_MAGIC.length).equals(PK_MAGIC);
}

/** 读取并校验 docx：存在、≤ 32 MiB、PK 开头。 */
async function readDocx(path: string): Promise<Buffer | 'tooLarge' | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    if (info.size > MAX_DOCX_BYTES) return 'tooLarge';
    const bytes = await readFile(path);
    if (bytes.length > MAX_DOCX_BYTES) return 'tooLarge';
    return hasDocxMagic(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * 旧版 .doc → .docx：调用本机 Word COM（仅 Windows）。纯 Node，缓存目录由调用方注入。
 * Word 只打开缓存目录下的临时副本，从不接触用户工作区。
 */
export function createWordConverter({ cacheDir }: { cacheDir: string }) {
  const tmpRoot = join(cacheDir, 'tmp');
  const inflight = new Map<string, Promise<WordConversionResult>>();
  let queue: Promise<unknown> = Promise.resolve();
  let unavailable = false;
  let tmpCleaned = false;

  async function cached(hash: string): Promise<Buffer | null> {
    const path = join(cacheDir, `${hash}.docx`);
    const bytes = await readDocx(path);
    if (bytes instanceof Buffer) {
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return bytes;
    }
    await unlink(path).catch(() => undefined);
    return null;
  }

  async function evict(): Promise<void> {
    const files: { path: string; size: number; mtime: number }[] = [];
    for (const name of await readdir(cacheDir).catch(() => [] as string[])) {
      if (!CACHE_NAME.test(name)) continue;
      const path = join(cacheDir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) files.push({ path, size: info.size, mtime: info.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let count = 0;
    let total = 0;
    for (const file of files) {
      count += 1;
      total += file.size;
      if (count > CACHE_MAX_FILES || total > CACHE_MAX_BYTES)
        await unlink(file.path).catch(() => undefined);
    }
  }

  /** 启动一次 PowerShell 转换；返回退出码，超时返回 'timeout'。 */
  function runWord(
    script: string,
    source: string,
    target: string
  ): Promise<number | 'timeout' | 'spawnError'> {
    return new Promise((resolve) => {
      const powershell = join(
        systemRoot(),
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const child = spawn(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, FYNVRA_DOC_SOURCE: source, FYNVRA_DOC_TARGET: target },
        }
      );
      let wordPid: number | null = null;
      let stdout = '';
      let settled = false;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length > 4096) return;
        stdout += chunk;
        const match = /^PID:(\d+)\s*$/m.exec(stdout);
        if (match) wordPid = Number(match[1]);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void (async () => {
          // DCOM 启动的 WINWORD 不是 PowerShell 的子进程，按脚本报告的 PID 单独结束；
          // 过滤映像名，PID 被复用时也不会误杀其他进程。
          if (child.pid) await taskkill(['/PID', String(child.pid), '/T', '/F']);
          if (wordPid)
            await taskkill(['/PID', String(wordPid), '/FI', 'IMAGENAME eq WINWORD.EXE', '/F']);
          resolve('timeout');
        })();
      }, TIMEOUT_MS);
      child.once('error', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve('spawnError');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(code ?? -1);
      });
    });
  }

  async function convertNow(hash: string, bytes: Buffer): Promise<WordConversionResult> {
    if (unavailable) return { ok: false, reason: 'unavailable' };
    if (!tmpCleaned) {
      tmpCleaned = true;
      // 清理上次异常退出遗留的临时副本；此时队列中没有其他转换。
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    const dir = join(tmpRoot, randomUUID());
    const script = join(dir, 'convert.ps1');
    const source = join(dir, 'source.doc');
    const target = join(dir, 'out.docx');
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(source, bytes, { flag: 'wx' });
      // 脚本为纯 ASCII 常量，随临时目录一起删除。
      await writeFile(script, SCRIPT, { encoding: 'utf8', flag: 'wx' });
      const outcome = await runWord(script, source, target);
      if (outcome !== 0) {
        if (outcome === EXIT_UNAVAILABLE || outcome === 'spawnError') unavailable = true;
        const reason: Failure['reason'] =
          outcome === 'timeout'
            ? 'timeout'
            : outcome === EXIT_UNAVAILABLE || outcome === 'spawnError'
              ? 'unavailable'
              : 'failed';
        console.warn(`[doc-preview] Word conversion ${reason} (exit ${String(outcome)})`);
        return { ok: false, reason };
      }
      const docx = await readDocx(target);
      if (docx === 'tooLarge') {
        console.warn('[doc-preview] converted docx exceeds size limit');
        return { ok: false, reason: 'tooLarge' };
      }
      if (!docx) {
        console.warn('[doc-preview] Word conversion produced no valid docx');
        return { ok: false, reason: 'failed' };
      }
      try {
        await rename(target, join(cacheDir, `${hash}.docx`));
        await evict();
      } catch {
        // 缓存写入失败不影响本次预览。
      }
      return { ok: true, docx };
    } catch (error) {
      console.warn(
        `[doc-preview] Word conversion failed (${(error as NodeJS.ErrnoException)?.code ?? 'error'})`
      );
      return { ok: false, reason: 'failed' };
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined
      );
    }
  }

  async function convert(bytes: Buffer): Promise<WordConversionResult> {
    if (process.platform !== 'win32') return { ok: false, reason: 'unavailable' };
    const hash = createHash('sha256').update(bytes).digest('hex');
    const running = inflight.get(hash);
    if (running) return running;
    const task = (async (): Promise<WordConversionResult> => {
      try {
        await mkdir(cacheDir, { recursive: true });
        const hit = await cached(hash);
        if (hit) return { ok: true, docx: hit };
      } catch {
        // 缓存不可用时仍尝试转换。
      }
      if (unavailable) return { ok: false, reason: 'unavailable' };
      // 全局串行：同一时间只跑一个 Word。
      const run = queue.then(() => convertNow(hash, bytes));
      queue = run.catch(() => undefined);
      return run;
    })().finally(() => inflight.delete(hash));
    inflight.set(hash, task);
    return task;
  }

  return { convert };
}

export type WordConverter = ReturnType<typeof createWordConverter>;
