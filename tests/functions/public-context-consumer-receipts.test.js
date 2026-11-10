import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import settings from "../../functions/lib/settings-publication.js";
import cards from "../../functions/lib/no-build-library-card-publication.js";
import records from "../../functions/lib/no-build-record-publication.js";
import { publicContextDigest } from "../../functions/lib/public-context-revision.js";

const aggregates = ["listings", "authors", "feed", "contentApi", "sitemap", "search"];
const routes = ["pages", "posts", "home"];
const release = "a".repeat(40), digest = publicContextDigest(7), budget = 300_000, now = 1_000_000;
const exact = { rendererSha: release, contextRevision: 7, contextDigest: digest, verifiedAt: 1 };
const timestamp = value => ({ toMillis: () => value });
const cases = [
  { kind: "settings", read: settings.settingsPublicationReceipt, required: [...routes, ...aggregates],
    clocks: ["settingsRetryAt", "triggeredAt", "createdAt"] },
  { kind: "card", read: cards.libraryCardReceipt, required: [...routes, ...aggregates], clocks: ["cardRetryAt", "createdAt"] },
  ...[["programs"], ["events"], ["programs", "events"]].map(families => ({ kind: "record", families,
    read: records.recordPublicationReceipt, required: ["pages", "home", "posts", "record", ...aggregates, ...families],
    clocks: ["recordRetryAt", "createdAt"] })),
];
function queueFor({ kind, families = [] }) {
  const identity = { schemaVersion: 1, rendererSha: release, contextRevision: 7, contextDigest: digest, sourceVersion: 2,
    snapshotDigest: "b".repeat(64), operationId: "A".repeat(20), originalOperationId: "A".repeat(20) };
  if (kind === "settings") Object.assign(identity, { id: "public-site-chrome", requiredConsumers: [...routes, ...aggregates],
    operationId: settings.settingsOperationId("public-site-chrome", 2), originalOperationId: settings.settingsOperationId("public-site-chrome", 2) });
  if (kind === "card") {
    const operationId = createHash("sha256").update(JSON.stringify(["library-card-publication-v1", "card-one", 2, "approve"])).digest("hex").slice(0, 20);
    Object.assign(identity, { kind: "newsletter", recordId: "card-one", action: "approve", withdrawal: false,
      cardDigest: "b".repeat(64), operationId, originalOperationId: operationId });
  }
  if (kind === "record") Object.assign(identity, { family: families[0], documentId: "record-one", generation: 1, visible: true });
  const key = { settings: "settingsPublication", card: "libraryCardPublication", record: "recordPublication" }[kind];
  return { transport: "public-context-no-build-v1", status: "success", runtime: { owner: "cloudflare", release },
    [key]: identity, publicContext: { ...identity, recordFamilies: families },
    aggregateReceipt: { runtime: { owner: "cloudflare", release }, contextRevision: 7, contextDigest: digest,
      outputs: Object.fromEntries([...aggregates, ...families].map(name => [name, { ...exact }])) },
    consumerReceipts: Object.fromEntries([...routes, "record"].map(name => [name, { ...exact }])) };
}

// Characterization of the three existing staff projections before M2 extraction.
describe.each(cases)("$kind consumer receipt characterization ($families)", options => {
  const { read, required, clocks } = options;
  it("requires each consumer from its original store and exact context", () => {
    expect(read(queueFor(options), now)).toMatchObject({ status: "success", missingConsumers: [] });
    for (const name of required) {
      const route = [...routes, "record"].includes(name);
      for (const patch of [null, { rendererSha: "c".repeat(40) }, { contextRevision: 8 }, { contextDigest: publicContextDigest(8) },
        ...[0, -1, NaN, Infinity, undefined].map(verifiedAt => ({ verifiedAt }))]) {
        const queue = queueFor(options);
        const store = route ? queue.consumerReceipts : queue.aggregateReceipt.outputs;
        store[name] = patch === null ? null : { ...exact, ...patch };
        (route ? queue.aggregateReceipt.outputs : queue.consumerReceipts)[name] = exact;
        expect(read(queue, now), name).toMatchObject({ status: "pending", missingConsumers: [name] });
      }
    }
  });
  it("rejects mixed aggregate identity while retaining independent route acknowledgements", () => {
    for (const patch of [{ runtime: { owner: "other", release } }, { runtime: { owner: "cloudflare", release: "c".repeat(40) } },
      { contextRevision: 8 }, { contextDigest: publicContextDigest(8) }]) {
      const queue = queueFor(options);
      Object.assign(queue.aggregateReceipt, patch);
      expect(read(queue, now)).toMatchObject({ status: "pending", missingConsumers: required.filter(name => ![...routes, "record"].includes(name)) });
    }
  });
  it("preserves warning clock precedence and its exact five-minute boundary", () => {
    for (let index = 0; index < clocks.length; index++) {
      const queue = queueFor(options);
      queue.consumerReceipts.home = null;
      for (const name of clocks.slice(index)) queue[name] = timestamp(1);
      queue[clocks[index]] = timestamp(now - budget + 1);
      expect(read(queue, now)).not.toHaveProperty("warning");
      queue[clocks[index]] = timestamp(now - budget);
      expect(read(queue, now).warning).toMatch(/longer than expected/);
    }
    const queue = queueFor(options);
    queue.consumerReceipts.home = null;
    expect(read(queue, now)).not.toHaveProperty("warning");
    for (const status of ["failed", "cancelled"]) expect(read({ ...queue, status }, now)).toMatchObject({ status: "failed", warning: expect.any(String) });
    if (options.kind === "record") {
      queue.recordPublication.visible = false;
      queue.recordRegeneration = "deferred";
      expect(read(queue, now)).toMatchObject({ status: "pending",
        warning: "Record removal is accepted. Card and index updates will resume when publishing resumes." });
    }
  });
});
