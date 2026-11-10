import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Explicit offline command. It never imports an SDK or reads a credential.
async function main() {
  const [mode, filename, ...receipts] = process.argv.slice(2);
  if (!filename || !["plan", "receipt"].includes(mode) || receipts.length !== (mode === "receipt" ? 2 : 0)) throw new Error();
  const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  // As in the installer, establish clean pinned source before helper imports.
  const bytes = readFileSync(filename); if (!bytes.length || bytes.length > 64 * 1024) throw new Error();
  const manifest = JSON.parse(bytes.toString("utf8"));
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!assertDevelopmentSource(root)) throw new Error();
  const head = git(["rev-parse", "HEAD"]);
  for (const role of ["OLD", "NEW"]) {
    const bytes = readFileSync(manifest[role].packetPath); if (!bytes.length || bytes.length > 64 * 1024) throw new Error();
    if (JSON.parse(bytes.toString("utf8"))?.sourceSha !== head) throw new Error();
  }
  const { bindPrivatePreviewPackets, exactPreviewFields, loadPrivatePreviewPacket, readPreviewJson } = await import("./lib/private-preview-packet.mjs");
  exactPreviewFields(manifest, ["schemaVersion", "oldRendererSha", "newRendererSha", "OLD", "NEW"]);
  const old = await loadPrivatePreviewPacket(manifest.OLD.packetPath, root, "receipt");
  const next = await loadPrivatePreviewPacket(manifest.NEW.packetPath, root, "receipt");
  const readbacks = mode === "receipt" ? { OLD: readPreviewJson(receipts[0], 256 * 1024).value, NEW: readPreviewJson(receipts[1], 256 * 1024).value } : undefined;
  process.stdout.write(JSON.stringify(bindPrivatePreviewPackets(manifest, old, next, readbacks)) + "\n");
}
main().catch(() => { process.stderr.write("Private preview packet binding refused\n"); process.exitCode = 1; });
