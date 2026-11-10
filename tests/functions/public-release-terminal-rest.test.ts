import { expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore";
import { releasePair } from "../helpers/private-public-release-pair";
import { pairOwnerEvidenceClient } from "../../publisher/pair-owner-evidence-client";
import { pairFirestoreReader, decodePairEvidenceFields } from "../../publisher/pair-work-reader";
import protocol from "../../functions/lib/public-release-pair.js";

it("decodes large and 101-element evidence over the actual emulator REST boundary while legacy bounds stay unchanged", async () => {
  const local = isolatedFirestore("terminal-evidence-rest"); // Requires a local emulator before any request.
  const firestore = new Proxy(local, { get(target, key) {
    if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const projectId = firestore.doc("system/publicReleaseAdmissions").firestore.projectId, token = "owner"; // Emulator's existing admin fixture token, never a provider credential.
  expect(projectId).toMatch(/^demo-/);
  expect(firestore.projectId).toBe("njpbs-site-dev");
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://firestore.googleapis.com") throw new Error("Unexpected evidence provider");
    const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}${url.pathname}${url.search}`, init);
    if (!response.ok && response.status !== 404) throw new Error(`Emulator evidence REST status ${response.status}`);
    return response;
  };
  const client = pairOwnerEvidenceClient({ projectId, token, pair: releasePair(), decode: decodePairEvidenceFields, request });
  const legacy = pairFirestoreReader({ projectId, token, request });
  const large = { schemaVersion: 2, proofs: Array.from({ length: 120 }, (_, index) => ({ path: `/path-${index}/`, digest: "a".repeat(64), detail: "x".repeat(800) })) };
  const small = { proofs: Array.from({ length: 101 }, (_, index) => ({ index })) };
  for (const value of [large, small]) {
    const ref = firestore.doc(`system/publicReleaseAdmissions/canonicalProofs/${protocol.publicReleaseDigest(value)}`);
    await ref.set(value);
    expect(await client.readTerminalEvidence(ref.path)).toEqual(value);
    await expect(legacy.read(ref.path)).rejects.toThrow(value === large ? "size limit" : "Invalid private pair array");
  }
});
