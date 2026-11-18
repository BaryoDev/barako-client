import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  external: ["@baryodev/barako-client"],
  banner: { js: "#!/usr/bin/env node" },
});
