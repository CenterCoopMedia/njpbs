import { createHash } from "node:crypto";
import { readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Windows setup consumes this exact shipped layout. User state is never included.
export const PACKAGE_FILES = Object.freeze([
  "vmix-agent.cjs", "setup.ps1", "install.ps1", "start.ps1", "studio.ps1", "pairing.json",
  "configuration.mjs", "read-studio-configuration.mjs", "studio-config.example.json",
  "Set up Studio connector.cmd", "Start Studio connector.cmd", "READ ME FIRST.txt", "Studio test guide.txt", "source.json",
]);
export async function writePackageInventory(directory, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Invalid connector inventory revision");
  const files = {};
  async function add(relative) {
    const path = join(directory, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Connector inventory cannot contain links");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await add(`${relative}/${name}`);
    } else if (info.isFile()) files[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
    else throw new Error("Unsupported connector package entry");
  }
  for (const name of PACKAGE_FILES) await add(name);
  await add("runtime");
  if (!files["runtime/node.exe"]) throw new Error("Connector runtime is missing");
  const inventory = { schemaVersion: 1, sourceSha, files };
  await writeFile(join(directory, "package-files.json"), JSON.stringify(inventory, null, 2) + "\n");
  return inventory;
}
