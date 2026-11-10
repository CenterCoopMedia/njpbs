import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import protocol from "../../functions/lib/public-release-pair.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const refuse = () => { throw new Error("Rate-control bundle was refused"); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function rateControlModuleManifest(modules) {
  if (!Array.isArray(modules) || !modules.length || modules.length > 32 || new Set(modules.map(row => row.name)).size !== modules.length) refuse();
  let total = 0;
  return modules.map(row => {
    if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(row.name ?? "") || row.name.split("/").includes("..") ||
        typeof row.content_type !== "string" || typeof row.content_base64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.content_base64)) refuse();
    const bytes = Buffer.from(row.content_base64, "base64"); total += bytes.length;
    if (total > 2 * 1024 * 1024) refuse();
    return { name: row.name, contentType: row.content_type, size: bytes.length, sha256: digest(bytes) };
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Canonical Wrangler preparation, offline with no inherited credentials/config.
 * Same method as the private publisher's existing preparation owner. No upload. */
export async function prepareCmsRateControlBundle() {
  const scratch = await mkdtemp(join(tmpdir(), "release-rate-bundle-"));
  try {
    // Wrangler resolves module paths relative to its config. Copying that
    // config changes emitted bytes, so use the actual tracked deployment path.
    const configPath = join(root, "cms-api/wrangler.jsonc"), multipartPath = join(scratch, "worker.multipart");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "versions", "upload", "--config", configPath,
        "--dry-run", "--outdir", join(scratch, "modules"), "--outfile", multipartPath], {
        cwd: scratch, stdio: "ignore", env: { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch,
          WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(scratch, "wrangler.log"),
          CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:9/client/v4", CI: "true" },
      });
      child.once("error", () => reject(new Error("Offline rate-control preparation failed")));
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Offline rate-control preparation failed")));
    });
    const bytes = await readFile(multipartPath), end = bytes.indexOf(10);
    if (bytes.length > 3 * 1024 * 1024 || end < 3 || end > 256) refuse();
    const boundary = bytes.subarray(0, end).toString("ascii").replace(/\r$/, "");
    if (!/^--[A-Za-z0-9_-]{1,200}$/.test(boundary)) refuse();
    const form = await new Response(bytes, { headers: { "content-type": `multipart/form-data; boundary=${boundary.slice(2)}` } }).formData();
    const names = [...form.keys()]; if (new Set(names).size !== names.length || typeof form.get("metadata") !== "string") refuse();
    const metadata = JSON.parse(form.get("metadata")), modules = [];
    for (const [name, part] of form) {
      if (name === "metadata") continue;
      if (!(part instanceof Blob)) refuse();
      modules.push({ name, content_type: part.type, content_base64: Buffer.from(await part.arrayBuffer()).toString("base64") });
    }
    const manifest = rateControlModuleManifest(modules);
    if (!manifest.some(row => row.name === metadata.main_module && row.contentType === "application/javascript+module")) refuse();
    return protocol.freeze({ bundle: { mainModule: metadata.main_module, modules: manifest }, code: modules,
      runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
