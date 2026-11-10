import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import p from "../../functions/lib/public-release-pair.js";
import a from "../../functions/lib/public-release-admission.js";
import settings from "../../functions/settings.js";
import media from "../../functions/lib/media-contract.js";
import { Timestamp } from "firebase-admin/firestore";
import work from "../../functions/lib/public-release-pair-work.js";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { activateStagedPublicReleasePairPublication } from "../../site/scripts/public-release-pair-content-activation";
import { DEFAULT_SITE_NAVIGATION, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  DEFAULT_NJ_DECIDES_SETTINGS } from "../../packages/content-core/src/cms-settings";
const db = isolatedFirestore("public-release-settings.test.ts");
let runtime: Miniflare, store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "settings-original-retry", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "settings-original-retry" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
afterAll(async () => { await runtime?.dispose(); });
const firestore = new Proxy(db, { get(owner, key) { if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(owner, key); return typeof value === "function" ? value.bind(owner) : value; } });
const actor = { uid: "pair-settings-editor", principal: { id: "pair-settings-editor", grants: [{ role: "admin" }] } };
const contract = { schemaVersion: 2, families: ["settings"], features: [] };
const values: Record<string, unknown> = { "site-navigation": DEFAULT_SITE_NAVIGATION, "public-site-chrome": DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  "public-homepage-banner": DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  "nj-decides-brand": { ...DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "brand", logoAlt: "NJ Decides" } };
const state = async (path: string) => (await db.doc(path).get()).data();
const deps = { firestore, requirePrincipalFn: async () => actor, now: () => "2026-10-28T12:00:00.000Z", log: { error() {} } };
async function invoke(handler: any, body: unknown) {
  const response: any = { code: 200, headersSent: false, set() { return this; }, status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, response);
  return response;
}
const publish = (id: string, baseVersion = 1) => invoke(settings.createCmsPublishSettingsHandler(deps), {
  id, baseVersion, publicationTransport: "public-context-no-build-v1" });
const get = (id: string) => invoke(settings.createCmsGetSettingsHandler(deps), { id });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await seedSwitch(firestore, { admittedContract: contract });
  await db.doc(`${a.CONTRACTS}/${p.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${a.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc(`users/${actor.uid}`).set({ role: "admin", active: true });
  for (const [id, setting] of Object.entries(values)) await db.doc(`cmsSettings/${id}`).set({ schemaVersion: 1, version: 1, values: setting });
  const image = { source: "upload", lifecycle: "active", mimeType: "image/png", sizeBytes: 99, width: 800, height: 300,
    url: "https://media.njpbs.org/cms-media/fixture/brand.png", altText: "NJ Decides" };
  await db.doc("media_assets/brand").set(image); await db.doc("media_assets_public/brand").set(media.mediaProjection(image));
});
it.each(Object.keys(values))("publishes %s through actual Settings dispatch with one original pair admission and consumer receipt", async id => {
  const before = await state("system/publicDeployment/contexts/public");
  const accepted = await publish(id);
  expect(accepted.code, JSON.stringify(accepted.body)).toBe(200);
  expect(accepted.body.publication).toMatchObject({ transport: a.TRANSPORT, status: "pending", sourceVersion: 1,
    rendererSha: "a".repeat(40), contextRevision: before!.revision + 1 });
  const operationId = accepted.body.publication.queueId;
  expect(await state(`cmsPublishQueue/${operationId}`)).toMatchObject({ status: "pending", transport: a.TRANSPORT,
    familyPublication: { kind: "settings", id }, triggeredBy: actor.uid });
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(1);
  expect((await get(id)).body.publication).toEqual(accepted.body.publication);
  expect(await state("system/publicDeployment/contexts/public")).toMatchObject({ revision: before!.revision + 1 });
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
});
it("returns the original pair receipt after selection and admission change without rewriting private Settings edits", async () => {
  const id = "public-site-chrome", first = await publish(id);
  expect(first.code, JSON.stringify(first.body)).toBe(200);
  const edited = await invoke(settings.createCmsSaveSettingsHandler(deps), { id, baseVersion: 2,
    values: { ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, newsletterLabel: "Private working label" } });
  expect(edited.code, JSON.stringify(edited.body)).toBe(200);
  const before = await state(`cmsSettings/${id}`), head = await state(a.ADMISSIONS), context = await state("system/publicDeployment/contexts/public");
  const queue = await state(`cmsPublishQueue/${first.body.publication.queueId}`), history = (await db.collection("cmsVersionHistory").get()).size;
  const selector = await state("system/publicDeployment");
  await db.doc("system/publicDeployment").update({ epoch: selector!.epoch + 1 });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  await db.doc("system/noBuildPostAdmission").update({ enabled: false, families: {} });
  const repeated = await publish(id);
  expect(repeated.code, JSON.stringify(repeated.body)).toBe(200);
  expect(repeated.body.publication).toEqual(first.body.publication);
  expect(await state(`cmsSettings/${id}`)).toEqual(before);
  expect(await state(a.ADMISSIONS)).toEqual(head);
  expect(await state("system/publicDeployment/contexts/public")).toEqual(context);
  expect(await state(`cmsPublishQueue/${first.body.publication.queueId}`)).toEqual(queue);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(history);
});
it("refuses branding before any source, admission, history or queue write when actual pair media authority is stale", async () => {
  const before = await state("cmsSettings/nj-decides-brand"), head = await state(a.ADMISSIONS);
  await db.doc("system/publicDeployment/pairMedia/current").update({ epoch: 99 });
  const response = await publish("nj-decides-brand");
  expect(response.code).toBe(409);
  expect(await state("cmsSettings/nj-decides-brand")).toEqual(before);
  expect(await state(a.ADMISSIONS)).toEqual(head);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
});
it("never reports pair Settings success from a queue flag without the original private terminal fact", async () => {
  const accepted = await publish("public-site-chrome");
  expect(accepted.code, JSON.stringify(accepted.body)).toBe(200);
  await db.doc(`cmsPublishQueue/${accepted.body.publication.queueId}`).update({ status: "success" });
  expect((await get("public-site-chrome")).code).not.toBe(200);
  expect((await db.collection(`${a.ADMISSIONS}/pending`).get()).size).toBe(1);
});
it("persists an overdue retry for the original pending owner and clears only the request warning", async () => {
  const id = "public-site-chrome", accepted = await publish(id);
  expect(accepted.code, JSON.stringify(accepted.body)).toBe(200);
  const operationId = accepted.body.publication.queueId, ref = db.doc(`cmsPublishQueue/${operationId}`);
  const globalPath = `${a.ADMISSIONS}/pending/${operationId}`, originalMarker = await state(globalPath);
  const queue = (await ref.get()).data()!, pair = (await state(work.publicReleasePairPath(queue.pair.pairId)))!;
  const pendingRef = db.doc(a.publicationPendingPath(pair.pairId, operationId));
  const pending = (await pendingRef.get()).data()!;
  expect(pending.nextAttemptAt).toBe(0);
  await pendingRef.update({ nextAttemptAt: Date.now() + 60_000 });
  await ref.update({ triggeredAt: Timestamp.fromMillis(Date.now() - 6 * 60_000) });
  expect((await get(id)).body.publication.warning).toEqual(expect.any(String));
  const settingsBefore = await state(`cmsSettings/${id}`), queueBefore = (await ref.get()).data()!;
  const head = await state(a.ADMISSIONS), context = await state("system/publicDeployment/contexts/public");
  const retried = await publish(id);
  expect(retried.code, JSON.stringify(retried.body)).toBe(200);
  expect(retried.body.publication).toEqual(accepted.body.publication);
  expect((await get(id)).body.publication.warning).toBeUndefined();
  expect((await pendingRef.get()).data()).toEqual({ ...pending, nextAttemptAt: 0 });
  expect(await state(globalPath)).toEqual(originalMarker);
  const queueAfter = (await ref.get()).data()!;
  const { settingsRetryAt, ...rest } = queueAfter;
  expect(settingsRetryAt.toMillis()).toBeGreaterThan(0);
  expect(rest).toEqual(queueBefore);
  expect(await state(`cmsSettings/${id}`)).toEqual(settingsBefore);
  expect(await state(a.ADMISSIONS)).toEqual(head);
  expect(await state("system/publicDeployment/contexts/public")).toEqual(context);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  // Persist real private H, deliberately omit the wake, then let the actual
  // opted-in executor hook consume the hint written by this handler retry.
  const admitted = (await state(`${a.ADMISSIONS}/operations/${operationId}`))!, entry = (await state(
    `system/publicReleaseChanges/entries/${String(admitted.changeSequence).padStart(16, "0")}`))!;
  const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
  const bytes = new TextEncoder().encode(canonical(settingsBefore!.published));
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(digest).toBe(admitted.source.snapshotDigest);
  const scope = { kind: "accepted", sourceOperationId: operationId, sourceVersion: admitted.source.sourceVersion,
    snapshotDigest: digest, contextSequence: admitted.changeSequence };
  const cursor = { baselineDigest: entry.previousDigest, sequence: admitted.changeSequence, lastDigest: entry.entryDigest };
  const root = { schemaVersion: 2, kind: "pair-render-input", pairDigest: p.publicReleaseDigest(pair),
    source: { kind: "settings", id }, scope, cursor, snapshotFile: "snapshot.json", entryFiles: ["snapshot.json"],
    files: [{ name: "snapshot.json", digest, bytes: bytes.length,
      objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${digest}.json`, dependencies: [] }] };
  await capturePublicReleasePairInput({ firestore, store, pair: pair as any, plan: root, expectedSource: root.source as any, expectedCursor: cursor,
    bindSourceOperation: true, files: (async function* () { yield { name: "snapshot.json", bytes }; })() });
  const executor = createPublicReleasePairExecutor({ firestore, store, pair: pair as any, originalRecovery: { enabled: true },
    publication: { activate: activateStagedPublicReleasePairPublication } });
  await executor.beforePoll!({});
  const tasks = await db.collection(`${work.publicReleasePairPath(pair.pairId)}/work`).get();
  expect(tasks.size).toBe(1);
  expect(tasks.docs[0].data()).toMatchObject({ status: "pending", attempts: 0,
    identity: { kind: "accepted", sourceOperationId: operationId, pair: admitted.pair, sourceVersion: admitted.source.sourceVersion } });
  expect(await state(globalPath)).toEqual(originalMarker);
  expect(await state(a.ADMISSIONS)).toEqual(head);
  expect(await state(`cmsSettings/${id}`)).toEqual(settingsBefore);
});
it("preserves failed original work and reports the need for help without pretending to reset its claim", async () => {
  const accepted = await publish("public-site-chrome");
  expect(accepted.code).toBe(200);
  const path = `cmsPublishQueue/${accepted.body.publication.queueId}`;
  await db.doc(path).update({ status: "failed", originalFailure: "retained" });
  const before = await state(path);
  expect((await get("public-site-chrome")).body.publication.warning).toBe("This site update needs help. Ask an administrator.");
  const retry = await publish("public-site-chrome");
  expect(retry.code).toBe(409);
  expect(retry.body.error).toBe("This site update needs help. Ask an administrator.");
  expect(await state(path)).toEqual(before);
});
