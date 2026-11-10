import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { parsePublicReleasePairFrozenOutput } from "../../site/scripts/public-release-pair-frozen-output";
const pair = releasePair(), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fixture(change?: (state: any) => void) {
  const packets = [
    { path: "/schedule/downloads/nj-pbs-schedule.pdf", name: "schedule-packet/pdf", mime: "application/pdf", body: "accepted-pdf", chunk: "provider/pdf/0000.json" },
    { path: "/_schedule-sources.json", name: "schedule-packet/json", mime: "application/json; charset=utf-8", body: "{}", chunk: "provider/json/0000.json" },
  ];
  packets.sort((a, b) => a.path < b.path ? -1 : 1);
  const files = new Map<string, { bytes: Uint8Array; dependencies: string[] }>();
  for (const name of ["snapshot.json", "source-census.json", "code-source.json", "code-pack.json", "code-pack-baseline.json"]) {
    files.set(name, { bytes: name === "snapshot.json" ? captured.files[1].bytes : encode({}), dependencies: [] });
  }
  for (const packet of packets) files.set(packet.chunk, { bytes: encode({ bodyBase64: Buffer.from(packet.body).toString("base64") }), dependencies: [] });
  const provider = { schemaVersion: 1, externalInputs: {}, retainedHome: null, files: packets.map(packet => ({ name: packet.name,
    key: `accepted/${packet.name}`, digest: hash(packet.body), bytes: Buffer.byteLength(packet.body), contentType: packet.mime, chunkFiles: [packet.chunk] })) };
  const plan = { schemaVersion: 1, kind: "pair-frozen-output", pairDigest: protocol.publicReleaseDigest(pair), codeAssetManifestDigest: pair.codeAssetManifestDigest,
    cursor: captured.cursor, outputs: packets.map(packet => ({ path: packet.path, dynamic: true, mime: packet.mime, size: Buffer.byteLength(packet.body),
      sha256: hash(packet.body), chunks: [{ name: packet.chunk, digest: hash(files.get(packet.chunk)!.bytes) }] })) };
  const baseline = { codeAssetManifestDigest: pair.codeAssetManifestDigest, members: packets.map(packet => ({ path: packet.path, mime: packet.mime,
    family: packet.name === "schedule-packet/pdf" ? "schedule" : "aggregate", source: "aggregate", dynamic: true })) };
  const dependencies = ["code-source.json", "source-census.json", "code-pack.json", "code-pack-baseline.json", "provider-inputs.json", ...packets.map(packet => packet.chunk)].sort();
  const state = { plan, provider, baseline, dependencies, entryFiles: ["frozen-output.json", "snapshot.json", "source-dependencies.json"] };
  change?.(state);
  files.set("provider-inputs.json", { bytes: encode(provider), dependencies: [] });
  files.set("frozen-output.json", { bytes: encode(plan), dependencies: [] });
  files.set("source-dependencies.json", { bytes: encode({ schemaVersion: 1 }), dependencies });
  const root = { ...captured.root, entryFiles: state.entryFiles, files: [...files].sort(([a], [b]) => a < b ? -1 : 1).map(([name, file]) => ({
    name, digest: hash(file.bytes), bytes: file.bytes.length, dependencies: file.dependencies,
    objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${hash(file.bytes)}.json` })) };
  return { bytes: files.get("frozen-output.json")!.bytes, context: { pair, identity, root, baseline, providerInputs: files.get("provider-inputs.json")!.bytes, sourceDependencies: files.get("source-dependencies.json")!.bytes } };
}
it("binds both exact accepted Schedule packet files, chunk roster and baseline dynamic authority to the actual H cursor", () => {
  const value = fixture(), parsed = parsePublicReleasePairFrozenOutput(value.bytes, value.context);
  expect(parsed.outputs.map(output => [output.path, output.dynamic])).toEqual([
    ["/_schedule-sources.json", true], ["/schedule/downloads/nj-pbs-schedule.pdf", true],
  ]);
  expect(parsed.cursor).toEqual(captured.cursor);
  expect(parsed.outputs[1].sha256).toBe(hash("accepted-pdf"));
  expect(Object.isFrozen(parsed.outputs[0].chunks)).toBe(true);
});
it.each(["cursor", "pair", "code-pack", "not-dynamic", "unknown-path", "mime", "packet-digest", "packet-size", "chunk-digest", "missing-dependency", "missing-entry", "partial-packet", "opcode"])("refuses %s", mode => {
  const value = fixture(state => {
    if (mode === "cursor") state.plan.cursor = { ...state.plan.cursor, lastDigest: "f".repeat(64) };
    if (mode === "pair") state.plan.pairDigest = "f".repeat(64);
    if (mode === "code-pack") state.baseline.codeAssetManifestDigest = "f".repeat(64);
    if (mode === "not-dynamic") state.baseline.members[0].dynamic = false;
    if (mode === "unknown-path") state.plan.outputs[0].path = "/other.pdf";
    if (mode === "mime") state.plan.outputs[0].mime = "text/html";
    if (mode === "packet-digest") state.provider.files[0].digest = "f".repeat(64);
    if (mode === "packet-size") state.provider.files[0].bytes++;
    if (mode === "chunk-digest") state.plan.outputs[0].chunks[0].digest = "f".repeat(64);
    if (mode === "missing-dependency") state.dependencies.splice(state.dependencies.indexOf("code-pack-baseline.json"), 1);
    if (mode === "missing-entry") state.entryFiles = ["snapshot.json"];
    if (mode === "partial-packet") state.plan.outputs.pop();
    if (mode === "opcode") state.plan.outputs[0].renderer = "custom";
  });
  expect(() => parsePublicReleasePairFrozenOutput(value.bytes, value.context)).toThrow();
});
it("refuses a byte-substituted provider envelope even if its metadata is plausible", () => {
  const value = fixture();
  value.context.providerInputs = encode({ schemaVersion: 1, externalInputs: {}, retainedHome: null, files: [] });
  expect(() => parsePublicReleasePairFrozenOutput(value.bytes, value.context)).toThrow();
});
