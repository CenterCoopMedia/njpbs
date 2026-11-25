import { expect, it, vi } from "vitest";
import { cloudflarePrivatePairProvider, checkPrivateWorkerVersion } from "../../scripts/lib/public-release-private-provider.mjs";
import { requireActiveVersion, WorkerReadbackFinal, WorkerReadbackMismatch, WorkerWriteRefused } from "../../scripts/lib/cloudflare-worker-readback.mjs";

const name = "njpbs-private-reader-fixture", tag = "a".repeat(64), version = "11111111-2222-4333-8444-555555555555";
const provider = fetcher => cloudflarePrivatePairProvider({ accountId: "b".repeat(32), credential: async () => "fixture", fetcher });

it.each([400, 403, 409])("reports a private Worker write that Cloudflare answered with HTTP %s as refused", async status => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", ""); vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
  const writes = provider(async () => new Response(null, { status }));
  for (const write of [() => writes.create(name, tag), () => writes.deploy(name, version, tag), () => writes.disableSubdomain(name)]) {
    await expect(write()).rejects.toBeInstanceOf(WorkerWriteRefused);
  }
  vi.unstubAllEnvs();
});

it.each([408, 429, 500, 503])("keeps a write that ended with HTTP %s uncertain", async status => {
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", ""); vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
  await expect(provider(async () => new Response(null, { status })).create(name, tag)).rejects.not.toBeInstanceOf(WorkerWriteRefused);
  vi.unstubAllEnvs();
});

it("ends on the exact immutable version with other bindings and waits while it is absent", () => {
  const metadata = { annotations: { "workers/message": "m" }, bindings: [], compatibility_date: "2026-01-01", compatibility_flags: [] };
  const row = { id: version, annotations: metadata.annotations, resources: { bindings: [{ name: "OTHER", type: "plain_text" }] } };
  expect(() => checkPrivateWorkerVersion(row, metadata, version)).toThrow(WorkerReadbackFinal);
  expect(() => checkPrivateWorkerVersion(null, metadata, version)).toThrow(WorkerReadbackMismatch);
});

it("reads an absent version as pending and a replaced or mixed one as settled", () => {
  const row = (...ids) => ({ versions: ids.map(version_id => ({ version_id, percentage: 100 / ids.length })) });
  expect(() => requireActiveVersion([row(version)], version, "v")).not.toThrow();
  expect(() => requireActiveVersion([row("other")], version, "v")).toThrow(WorkerReadbackMismatch);
  expect(() => requireActiveVersion([], version, "v")).toThrow(WorkerReadbackMismatch);
  expect(() => requireActiveVersion([row("other"), row(version)], version, "v")).toThrow(WorkerReadbackFinal);
  expect(() => requireActiveVersion([row(version, "other")], version, "v")).toThrow(WorkerReadbackFinal);
});
