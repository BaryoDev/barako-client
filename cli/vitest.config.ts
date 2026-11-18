import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts"],
  },
  resolve: {
    alias: {
      "@baryodev/barako-client": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
});
