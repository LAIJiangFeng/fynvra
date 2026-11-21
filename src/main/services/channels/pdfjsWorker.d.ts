// pdfjs-dist 没有为 legacy 的 .min 入口提供类型：主模块沿用 pdf.mjs 的类型，worker 只为副作用（设置 globalThis.pdfjsWorker）导入
declare module 'pdfjs-dist/legacy/build/pdf.min.mjs' {
  export * from 'pdfjs-dist/legacy/build/pdf.mjs';
}
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
