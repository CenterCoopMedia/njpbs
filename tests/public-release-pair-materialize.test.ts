import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { materializePublicReleasePairInput } from "../site/scripts/public-release-pair-materialize";

const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const files = Array.from({ length: 6 }, (_, index) => ({ name: `${index}.json` }));

it("keeps every file and checkpoint behind a four-read materialization barrier", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pair-materialize-")), gates = files.map(deferred), started: string[] = [];
  let checkpoints = 0;
  try {
    const result = materializePublicReleasePairInput({ files, directory, signal: new AbortController().signal,
      checkpoint: async () => { checkpoints++; }, read: async name => {
        started.push(name); await gates[Number(name[0])].promise; return new TextEncoder().encode(name);
      } });
    await expect.poll(() => started.length).toBe(4);
    expect(started).toEqual(files.slice(0, 4).map(file => file.name));
    for (const gate of gates) gate.release();
    await result;
    expect(checkpoints).toBe(6);
    for (const file of files) expect(await readFile(path.join(directory, file.name), "utf8")).toBe(file.name);
  } finally { for (const gate of gates) gate.release(); await rm(directory, { recursive: true, force: true }); }
});

it("drains a failed batch, preserving its first error and never starting later files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pair-materialize-")), gate = deferred(), started: string[] = [];
  let settled = false;
  try {
    const result = materializePublicReleasePairInput({ files, directory, signal: new AbortController().signal,
      checkpoint: async () => {}, read: async name => {
        started.push(name);
        if (name === "0.json") throw new Error("original H refusal");
        await gate.promise; return new TextEncoder().encode(name);
      } });
    const checked = expect(result).rejects.toThrow("original H refusal");
    void result.then(() => { settled = true; }, () => { settled = true; });
    await expect.poll(() => started.length).toBe(4);
    expect(settled).toBe(false);
    gate.release(); await checked;
    expect(started).toHaveLength(4);
    expect(await readdir(directory)).toEqual(["1.json", "2.json", "3.json"]);
  } finally { gate.release(); await rm(directory, { recursive: true, force: true }); }
});

it("refuses an already aborted task before reading or materializing any file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pair-materialize-")), controller = new AbortController();
  controller.abort(); let reads = 0;
  try {
    await expect(materializePublicReleasePairInput({ files, directory, signal: controller.signal,
      checkpoint: async () => {}, read: async () => { reads++; return new Uint8Array(); } })).rejects.toThrow();
    expect(reads).toBe(0); expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
