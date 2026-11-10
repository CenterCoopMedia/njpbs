import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { transform } from "esbuild";

const siteTypeScript = /\/site\/.*\.ts(?:\?.*)?$/;

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  // Shared reader modules need type stripping independent of Site's Astro config.
  oxc: { exclude: siteTypeScript },
  plugins: [{
    name: "cloud-test-site-typescript",
    enforce: "pre",
    async transform(code, id) {
      if (!siteTypeScript.test(id)) return;
      return transform(code, { loader: "ts", target: "es2023", sourcefile: id,
        sourcemap: true, tsconfigRaw: { compilerOptions: {} } });
    },
  }],
  test: { environment: "node", include: ["publisher/**/*.test.ts"] },
});
