#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseReaderInstallAdapterConfig } from "./lib/cms-reader-first-install-adapter.mjs";

/** Offline, reviewable single-file bundle. Runtime SDK packages come from the
 * protected checkout's installed lockfile; all repository code is bundled. */
export async function buildReaderInstallAdapter(config, output) {
  config = parseReaderInstallAdapterConfig(config);
  const entry = new URL("./lib/cms-reader-install-bundle-entry.mjs", import.meta.url);
  const sdkRoot = new URL("../package.json", import.meta.url);
  const result = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, write: false, platform: "node", format: "esm", target: "node22",
    packages: "external", logLevel: "silent", define: { READER_INSTALL_ADAPTER_CONFIG: JSON.stringify(config), "import.meta.url": JSON.stringify(entry.href) },
    banner: { js: `import { createRequire as __readerRequire } from 'node:module'; const require = __readerRequire(${JSON.stringify(sdkRoot.href)});` } });
  const bytes = result.outputFiles[0].contents;
  writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
  return { adapterPath: resolve(output), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [configPath, output] = process.argv.slice(2);
    if (process.argv.length !== 4 || !configPath || !output) throw new Error();
    process.stdout.write(`${JSON.stringify(await buildReaderInstallAdapter(JSON.parse(readFileSync(configPath, "utf8")), output))}\n`);
  } catch { process.stderr.write("CMS reader adapter build refused.\n"); process.exitCode = 1; }
}
