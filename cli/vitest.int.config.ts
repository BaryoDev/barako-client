import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@baryodev/barako-client": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["cli/test/**/*.int.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
