import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ["default"],
  },
});
