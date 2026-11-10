#!/usr/bin/env node
import { appendFileSync, constants, copyFileSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
// The previous approved synthetic fixture predates generation receipts.
const previousFixture = "1be673cbbe1ae41c1772adc2d8d2a15b4778832f7b12f1959167b4ee98ee68bb";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function regularFile(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error("Functions emulator environment must be a regular local file.");
  }
}
function receiptDigest(path) {
  try {
    regularFile(path);
    const value = readFileSync(path, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Firebase resolves promptable parameters from dotenv files before loading
// Functions. Supply the committed synthetic fixture on a clean checkout while
// preserving any environment the developer has already configured locally.
export function prepareEmulatorEnv(root = repository) {
  const directory = lstatSync(join(root, "functions"));
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("Functions emulator environment requires a real local directory.");
  }
  const fixture = join(root, "scripts/fixtures/functions-emulator.env.example");
  const local = join(root, "functions/.env.local");
  const receipt = join(root, "functions/.emulator-env.sha256");
  const source = readFileSync(fixture);
  const sourceDigest = digest(source);
  const managedDigest = receiptDigest(receipt);
  const recordGeneration = () => writeFileSync(receipt, `${sourceDigest}\n`, { mode: 0o600 });
  try {
    copyFileSync(fixture, local, constants.COPYFILE_EXCL);
    recordGeneration();
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      regularFile(local);
      const content = readFileSync(local);
      const localDigest = digest(content);
      if (localDigest === sourceDigest || localDigest === managedDigest || localDigest === previousFixture) {
        if (localDigest !== sourceDigest) writeFileSync(local, source);
        recordGeneration();
        return false;
      }
      const keys = new Set([...content.toString("utf8").matchAll(/^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/gm)].map(match => match[1]));
      const missing = source.toString("utf8").split("\n").filter(line => {
        const key = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
        return key && !keys.has(key);
      });
      // Append only known synthetic defaults; never copy or overwrite local values.
      if (missing.length) appendFileSync(local, `\n${missing.join("\n")}\n`);
      return false;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Emulator setup accepts no arguments.");
  prepareEmulatorEnv();
}
