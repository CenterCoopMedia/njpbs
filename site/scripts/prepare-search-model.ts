import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSearchEncoder } from "../src/search/model";

const offline = process.argv.includes("--offline");
if (offline) {
  globalThis.fetch = async () => {
    throw new Error("Offline model check attempted network access");
  };
}
// Prepare the release before its network-isolated publication build starts.
const encoder = await loadSearchEncoder(offline);
const output = await encoder("Search model readiness check.", {
  pooling: "mean",
  normalize: true,
});
if (output.data.length !== 384)
  throw new Error("Search model dimensions differ");
await encoder.dispose();
if (!offline) {
  // A fresh process prevents an in-memory metadata cache from hiding missing files.
  execFileSync(
    process.execPath,
    [
      "--import",
      fileURLToPath(
        new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
      ),
      fileURLToPath(import.meta.url),
      "--offline",
    ],
    { stdio: "inherit" },
  );
} else {
  console.log(
    "Search model cache passed a fresh-process offline inference check.",
  );
}
