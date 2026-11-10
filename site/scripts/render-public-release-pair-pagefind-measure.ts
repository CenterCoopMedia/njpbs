import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildPublicReleasePairPagefind } from "./public-release-pair-pagefind";
const files = JSON.parse(await readFile("/preview/input.json", "utf8"));
if (!Array.isArray(files) || !files.length || files.length > 100_000) throw new Error("Frozen census unavailable");
globalThis.fetch = async () => { throw new Error("Frozen census has no network"); };
async function* html() {
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (file.file !== `${index}.html` || typeof file.path !== "string" || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 16 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(file.digest)) throw new Error("Frozen census unavailable");
    const bytes = await readFile(`/pair/inputs/${file.file}`);
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new Error("Frozen census changed");
    yield { path: file.path, bytes };
  }
}
const output = await buildPublicReleasePairPagefind(html(), "/pair/pagefind");
await writeFile("/preview/dist/metrics.json", JSON.stringify(output.metrics), { flag: "wx", mode: 0o600 });
