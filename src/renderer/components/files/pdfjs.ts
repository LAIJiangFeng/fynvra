import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * pdf.js 的离线资源。生产环境页面走 file://，pdf.js 自带的 fetch / XHR 读取本地文件并不可靠，
 * 所以 cMap 和标准字体经 Vite 以 data: URL 内联进按需加载的 chunk（每个文件一个），
 * 由自定义 BinaryDataFactory 在主线程解码后交给 worker，全程不发网络或 file:// 请求。
 * 开发环境下 Vite 可能返回 dev server 地址，此时走同源 fetch。
 */
const cMaps = import.meta.glob<string>('../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
  query: '?url&inline',
  import: 'default',
  exhaustive: true,
});
const standardFonts = import.meta.glob<string>(
  '../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  { query: '?url&inline', import: 'default', exhaustive: true }
);

function byFileName(table: Record<string, () => Promise<string>>) {
  return new Map(
    Object.entries(table).map(([path, load]) => [path.slice(path.lastIndexOf('/') + 1), load])
  );
}

const resources = {
  cMapUrl: byFileName(cMaps),
  standardFontDataUrl: byFileName(standardFonts),
} as const;

async function toBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const binary = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.statusText);
  return new Uint8Array(await response.arrayBuffer());
}

/** 只认 pdf.js 内置的文件名，不接受任意 URL。 */
class BundledDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const table =
      kind === 'cMapUrl' || kind === 'standardFontDataUrl' ? resources[kind] : undefined;
    const load = table?.get(filename);
    if (!load) throw new Error(`Missing bundled PDF resource: ${kind}/${filename}`);
    return toBytes(await load());
  }
}

let ready: Promise<typeof import('pdfjs-dist')> | undefined;

/** 懒加载 pdf.js；worker 由 Vite 作为静态资源输出。 */
function loadPdfJs() {
  ready ??= import('pdfjs-dist').then((pdfjs) => {
    // worker 创建或加载失败时，pdf.js 会自动以主线程模式（fake worker）import 同一模块继续解析。
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  });
  return ready;
}

export async function openPdf(data: Uint8Array) {
  const pdfjs = await loadPdfJs();
  const params = {
    // pdf.js 会把数据转移给 worker，复制一份，避免分离 store 中的预览字节。
    data: data.slice(),
    BinaryDataFactory: BundledDataFactory,
    // 占位地址：资源实际由 BundledDataFactory 按文件名提供（pdf.js 要求以 / 结尾）。
    cMapUrl: 'bundled:/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'bundled:/standard_fonts/',
    useWorkerFetch: false,
    // CSP 不含 wasm-unsafe-eval；关闭 wasm，PostScript 函数走解释器而非编译执行。
    useWasm: false,
    // pdf.js 6 已移除基于 eval 的字体/函数编译（该选项不再读取），仍显式关闭以示意图。
    isEvalSupported: false,
    enableXfa: false,
  };
  return pdfjs.getDocument(params);
}

export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
