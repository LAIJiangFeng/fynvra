import { defineConfig } from 'vitest/config';

// 包内独立运行用；并入根 workspace 后由根 vitest.config.ts 的 packages/*/src/** 覆盖
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
