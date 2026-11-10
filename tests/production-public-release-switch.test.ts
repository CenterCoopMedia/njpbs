import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import protocol from "../functions/lib/public-release-pair.js";
import { releasePair } from "./helpers/private-public-release-pair.js";
import { parseProductionSwitchPacket } from "../scripts/lib/production-public-release-switch.mjs";
import { createProductionSwitchStore } from "../scripts/lib/production-public-release-switch-store.mjs";
const { S3Client } = createRequire(new URL("../site/package.json", import.meta.url))("@aws-sdk/client-s3");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pair = (slot: string) => ({ ...releasePair(slot, slot.repeat(40)), environment: "production" });
const packet = () => ({ schemaVersion: 1, kind: "production-public-release-switch", operatorCommitSha: "a".repeat(40),
  credentialIdentity: { projectId: "njpbs-site", clientEmail: "switch-operator@njpbs-site.iam.gserviceaccount.com",
    privateKeyId: "a".repeat(40), secretRef: "pass://synthetic/switch-sdk" }, oldPair: pair("a"), newPair: pair("b"),
  direction: "new", operationId: "switch-new", forwardOperationId: null, qualificationAttemptId: "proof-one",
  readers: [{ origin: "https://pair-old.njpbs.org", clientId: "old.access" }, { origin: "https://pair-new.njpbs.org", clientId: "new.access" }],
  operator: { origin: "https://pair-operator.njpbs.org", clientId: "operator.access" },
  ingressAdoption: { filename: "/synthetic/adoption.json", digest: "a".repeat(64) }, observations: [] });

it("requires production identity, original return identity and a closed non-scenario packet", () => {
  const value = packet();
  expect(parseProductionSwitchPacket(value)).toEqual(value);
  expect(() => parseProductionSwitchPacket({ ...value, publications: [] })).toThrow();
  expect(() => parseProductionSwitchPacket({ ...value, oldPair: releasePair() })).toThrow();
  expect(() => parseProductionSwitchPacket({ ...value, credentialIdentity: { ...value.credentialIdentity, projectId: "njpbs-site-dev" } })).toThrow();
  expect(() => parseProductionSwitchPacket({ ...value, direction: "old" })).toThrow();
  expect(() => parseProductionSwitchPacket({ ...value, direction: "old", forwardOperationId: "switch-new" })).toThrow();
  expect(parseProductionSwitchPacket({ ...value, direction: "old", operationId: "return-old", forwardOperationId: "switch-new" }).direction).toBe("old");
  for (const origin of ["https://outside.example", "http://pair-operator.njpbs.org", "https://dev-pair-operator.njpbs.org", "https://pair-operator.njpbs.org/?q=1"]) {
    expect(() => parseProductionSwitchPacket({ ...value, operator: { ...value.operator, origin } })).toThrow();
  }
});

it("refuses malformed invocations before any credential or network initialization", () => {
  const result = spawnSync(process.execPath, ["scripts/switch-production-public-release.mjs", "--apply"], { encoding: "utf8",
    env: { PATH: process.env.PATH, FIRESTORE_EMULATOR_HOST: "127.0.0.1:1" }, timeout: 5000 });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Production switch was not confirmed; preserve the original packet and use --readback\n");
});

it("serializes only pair-bound conditional qualification evidence to the fixed production bucket", async () => {
  const pairs = [pair("a"), pair("b")], digest = protocol.publicReleaseDigest(pairs[0]);
  const body = Buffer.from('{"native":"evidence"}'), bodyDigest = sha(body), witness = "d".repeat(64);
  const key = `release-pair-qualifications/v1/${digest}/${"c".repeat(64)}/roots/${bodyDigest}.json`;
  const requests: any[] = [];
  // The fake HTTP provider receives real AWS SDK serialization and signing.
  // Its success/error documents follow the S3 Get/PutObject wire contract.
  const client = new S3Client({ endpoint: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: "synthetic-test-id", secretAccessKey: "synthetic-test-key" }, maxAttempts: 1,
    requestHandler: { async handle(request: any) {
      requests.push(request);
      if (request.method === "PUT") return { response: { statusCode: requests.length === 1 ? 200 : 412, headers: {},
        body: Readable.from(requests.length === 1 ? [] : ['<Error><Code>PreconditionFailed</Code></Error>']) } };
      return { response: { statusCode: 200, headers: { "content-length": String(body.length), "x-amz-meta-bodydigest": bodyDigest }, body: Readable.from([body]) } };
    }, destroy() {} } });
  const store = createProductionSwitchStore({ pairs, client, readCredential: async () => { throw new Error("Unexpected credential read"); } });
  const options = { onlyIf: { etagDoesNotMatch: "*" }, sha256: bodyDigest,
    customMetadata: { schemaversion: "1", pairdigest: digest, witnessdigest: witness, bodydigest: bodyDigest } };
  try {
    await store.put(key, body, options);
    await store.put(key, body, options); // 412 leaves the original object for native full readback.
    const object = await store.get(key);
    expect(await new Response(object!.body).text()).toBe(body.toString());
    expect(object!.customMetadata).toEqual({ bodydigest: bodyDigest });
    expect(requests.map(request => [request.method, request.hostname, request.path])).toEqual([
      ["PUT", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", `/njpbs-cms-publication/${key}`],
      ["PUT", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", `/njpbs-cms-publication/${key}`],
      ["GET", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", `/njpbs-cms-publication/${key}`],
    ]);
    expect(requests[0].headers["if-none-match"]).toBe("*");
    expect(requests[0].headers["x-amz-meta-pairdigest"]).toBe(digest);
    await expect(store.put(key, body, { ...options, onlyIf: { etagDoesNotMatch: "wrong" } })).rejects.toThrow();
    await expect(store.put(`release-pairs/${pairs[0].pairId}/objects/${bodyDigest}`, body, options)).rejects.toThrow();
    expect(() => store.get("release-pair-inputs/v2/unrelated/source.json")).toThrow();
    expect(requests).toHaveLength(3);
  } finally { store.close(); client.destroy(); }
  const readonly = createProductionSwitchStore({ pairs, readOnly: true, readCredential: async () => { throw new Error("Unexpected credential read"); } });
  await expect(readonly.put(key, body, options)).rejects.toThrow(); readonly.close();
});
