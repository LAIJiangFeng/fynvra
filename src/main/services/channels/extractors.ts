// 渠道附件的文档解析器（pdf / docx / xlsx 抽纯文本）。生产中只在隔离的 worker 线程里运行（docWorker.ts），
// 解析不可信输入不占用 Main 主线程；单元测试可直接在进程内调用。
import {
  type ChatFileExtractors,
  pdfDocumentText,
  repackXlsx,
  sheetsToText,
  type XlsxSheet,
} from '@shared/chatFileText';

async function extractPdfText(data: Uint8Array): Promise<string> {
  // 用 .min 构建：未压缩的 pdf.mjs 里有局部 `const require`，打进 Main 产物后会触发 require 声明检查（见 fflateImport.test.ts）
  // 先加载 worker 模块：它会设置 globalThis.pdfjsWorker，pdf.js 随后在本线程内（fake worker）解析，不再另起线程也不按路径 import
  await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
  // shortcut: 未提供 cMap 与标准字体资源，缺 ToUnicode 的 CJK 字体可能抽不出字；需要时把 cmaps 作为资源打进包再传 cMapUrl
  const params = {
    data: data.slice(),
    // 只抽文字不渲染：不装字体、不读系统字体、不用 wasm
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    // pdf.js 6 已移除基于 eval 的编译（该选项不再读取），仍显式关闭以示意图
    isEvalSupported: false,
    enableXfa: false,
    verbosity: 0,
  };
  const task = getDocument(params);
  try {
    return await pdfDocumentText(await task.promise);
  } finally {
    void task.destroy();
  }
}

async function extractDocxText(data: Uint8Array): Promise<string> {
  const { default: mammoth } = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return value;
}

async function extractXlsxText(data: Uint8Array): Promise<string> {
  // Main 只能用 fflate/browser：node 版的 `var require` 会与 electron-vite 的 require shim 重名
  const [fflate, { default: readXlsxFile }] = await Promise.all([
    import('fflate/browser'),
    import('read-excel-file/universal'),
  ]);
  const sheets = await readXlsxFile(repackXlsx(data, fflate).slice().buffer);
  return sheetsToText(sheets as unknown as XlsxSheet[]);
}

export const MAIN_EXTRACTORS: ChatFileExtractors = {
  pdf: extractPdfText,
  docx: extractDocxText,
  xlsx: extractXlsxText,
};
