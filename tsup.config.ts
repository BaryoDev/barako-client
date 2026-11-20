import { defineConfig } from "tsup";

// No `clean` here: the build script empties dist first, so the two builds cannot delete each other.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    platform: "node",
    target: "node18",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
