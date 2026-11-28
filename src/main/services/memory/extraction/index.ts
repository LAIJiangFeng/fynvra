// 验收提炼入口（ARCHITECTURE §7.15）：T6 在 main/index.ts 里把 registry.onTaskAccepted 接到 enqueue。
export {
  createExtractionRunner,
  type ExtractionDeps,
  type ExtractionRunner,
} from './runner';
