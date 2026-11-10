import { readFile } from "node:fs/promises";
import path from "node:path";
import { build, transform } from "esbuild";

/** Keep SDKs external and preserve each owned module's original path semantics. */
export async function buildPreviewRuntime(repository) {
  return build({
    absWorkingDir: repository,
    entryPoints: ["site/scripts/cms-preview-cloud-runtime.ts"],
    outfile: path.join(repository, "site/.compiled-renderer/runtime/cloud.mjs"),
    bundle: true, packages: "external", platform: "node", format: "esm", target: "node22",
    metafile: true,
    plugins: [{
      name: "original-module-url",
      setup(builder) {
        builder.onLoad({ filter: /\.(ts|mjs|js)$/ }, async ({ path: filename }) => {
          const relative = path.relative(repository, filename).split(path.sep).join("/");
          if (relative.startsWith("../") || path.isAbsolute(relative) || relative.split("/").includes("node_modules")) {
            throw new Error("Preview runtime can bundle only owned source modules");
          }
          // Transform syntax rather than replacing text inside comments or strings.
          const result = await transform(await readFile(filename, "utf8"), {
            loader: filename.endsWith(".ts") ? "ts" : "js", target: "node22",
            define: { "import.meta.url": "__cmsOriginalModuleUrl" },
          });
          return {
            contents: `const __cmsOriginalModuleUrl = new URL(${JSON.stringify(relative)}, new URL("../../../", import.meta.url)).href;\n${result.code.replace(/^#![^\n]*(?:\n|$)/, "")}`,
            loader: "js",
          };
        });
      },
    }],
  });
}
