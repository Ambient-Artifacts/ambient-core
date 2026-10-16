import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["spec/test/**/*.test.ts", "wiki/test/**/*.test.ts", "gateway/test/**/*.test.ts", "control/test/**/*.test.ts", "team/test/**/*.test.ts", "eval/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
