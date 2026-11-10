// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import mediaUsage from "../../functions/lib/media-usage.js";
import { applySupportMigration, reviewSupportMigration } from "../../scripts/migrate-support-page-layout.mts";
const fixturePath = new URL("./fixtures/public-contracts/support-layout.json", import.meta.url);
const before = JSON.parse(readFileSync(fixturePath, "utf8"));
const now = new Date("2026-10-06T12:00:00Z");

afterEach(() => vi.restoreAllMocks());
function fakeFirestore(document = structuredClone(before), lock?: Record<string, unknown>) {
  const writes: Array<{ method: string; path: string; value: Record<string, unknown> }> = [];
  const transaction = {
    getAll: vi.fn(async () => [{ exists: true, data: () => structuredClone(document) }, { exists: !!lock, data: () => lock }]),
    update: (ref: { path: string }, value: Record<string, unknown>) => { writes.push({ method: "update", path: ref.path, value }); Object.assign(document, value); },
    create: (ref: { path: string }, value: Record<string, unknown>) => writes.push({ method: "create", path: ref.path, value }),
    set: (ref: { path: string }, value: Record<string, unknown>) => writes.push({ method: "set", path: ref.path, value }),
  };
  const firestore = { collection: (name: string) => ({ doc: (id = "operator-fixture") => ({ path: `${name}/${id}` }) }),
    runTransaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction) };
  vi.spyOn(mediaUsage, "prepareMediaUsageWrite").mockResolvedValue({ ref: { path: "cmsMediaUsage/support-working" }, document: { state: "working" } });
  return { firestore: firestore as unknown as Firestore, writes, document };
}

describe("reviewed draft-only support operator", () => {
  it("executes the real CLI dry-run with fixture values", () => {
    const output = execFileSync(new URL("../node_modules/.bin/tsx", import.meta.url).pathname, [
      new URL("../../scripts/migrate-support-page-layout.mts", import.meta.url).pathname, "--fixture", fixturePath.pathname,
    ], { encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ mode: "dry-run", changed: true, fromVersion: 7, toVersion: 8 });
  });
  it("commits only a draft, revision, working media usage and audit, then reruns without writing", async () => {
    const { firestore, writes, document } = fakeFirestore();
    expect(await applySupportMigration(firestore, reviewSupportMigration(before).fingerprint, now)).toMatchObject({
      mode: "applied-draft", changed: true, fromVersion: 7, toVersion: 8,
    });
    expect(writes.map(write => [write.method, write.path])).toEqual([
      ["update", "cmsPages/support"], ["create", "cmsVersionHistory/operator-fixture"],
      ["set", "cmsMediaUsage/support-working"], ["create", "admin_logs/operator-fixture"],
    ]);
    expect(writes[0].value).toMatchObject({ status: "draft", version: 8, contentVersion: 8, serviceCompositionVersion: 1 });
    expect(Object.keys(writes[0].value).sort()).toEqual(["blocks", "contentVersion", "serviceCompositionVersion", "status", "updatedAt", "updatedBy", "version"]);
    expect(document.published).toEqual(before.published);
    expect(document.publiclyVisible).toBe(true);
    expect(document.publicSourceVersion).toBe(7);
    expect(document.blocks.find((block: { id: string }) => block.id === "fixture-daf").data).toEqual(before.blocks[5].data);
    expect(writes[1].value.before).toEqual(before);
    const count = writes.length;
    expect(await applySupportMigration(firestore, reviewSupportMigration(before).fingerprint, now)).toMatchObject({
      mode: "already-migrated", changed: false, fromVersion: 8, toVersion: 8,
    });
    expect(writes).toHaveLength(count);
  });
  it("writes nothing when staff has changed the reviewed draft or holds an editor lease", async () => {
    const fresh = fakeFirestore({ ...before, title: "Staff edit" });
    await expect(applySupportMigration(fresh.firestore, reviewSupportMigration(before).fingerprint, now)).rejects.toThrow(/changed/);
    expect(fresh.writes).toEqual([]);
    const active = fakeFirestore(structuredClone(before), { heartbeatAt: { toMillis: () => now.getTime() } });
    await expect(applySupportMigration(active.firestore, reviewSupportMigration(before).fingerprint, now)).rejects.toThrow(/active support editor/);
    expect(active.writes).toEqual([]);
  });
  it("refuses ambiguous legacy visibility and overflowing versions", () => {
    expect(() => reviewSupportMigration({ ...before, publiclyVisible: undefined })).toThrow(/Legacy public visibility/);
    expect(() => reviewSupportMigration({ ...before, version: Number.MAX_SAFE_INTEGER })).toThrow(/incremented safely/);
    expect(() => reviewSupportMigration({ ...before, contentVersion: -1 })).toThrow(/invalid contentVersion/);
  });
  it("accepts a released lease and refuses a malformed release carrying an active heartbeat", async () => {
    const released = fakeFirestore(structuredClone(before), { releasedAt: { toMillis: () => now.getTime() } });
    await expect(applySupportMigration(released.firestore, reviewSupportMigration(before).fingerprint, now)).resolves.toMatchObject({ changed: true });
    const malformed = fakeFirestore(structuredClone(before), { releasedAt: true, heartbeatAt: { toMillis: () => now.getTime() } });
    await expect(applySupportMigration(malformed.firestore, reviewSupportMigration(before).fingerprint, now)).rejects.toThrow(/active support editor/);
    expect(malformed.writes).toEqual([]);
  });
});
