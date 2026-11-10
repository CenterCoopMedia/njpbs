import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import deployment from "../../functions/lib/public-deployment.js";
import reportingContract from "../../functions/lib/data-hub-reporting.js";
import reportingInput from "../../functions/lib/data-hub-reporting-input.js";
import reportingSources from "../../functions/lib/data-hub-reporting-sources.js";
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { cloudExternalRefresh, restoreCloudExternalInputs } from "../../site/scripts/cloud-external-refresh";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { readCloudSchedulePacket } from "../../site/scripts/cloud-schedule-packet";
import storageModule from "../../functions/lib/post-background-storage.js";
import context from "../../functions/lib/public-context-revision.js";
import state from "../../functions/lib/cloud-external-refresh-state.js";

const db = isolatedFirestore("cloud-external-refresh.test.ts");
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let directory: string;
let release: string;
let now: number;
let title: string;
let outage: boolean;
let requests: number;
let tvssRequests: number;
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use local demo emulators");
  release = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  directory = await mkdtemp(path.join(tmpdir(), "cloud-external-refresh-"));
  boundary = await backgroundStorageFixture("fixture-bucket");
  app = firebaseAdminRuntime.initializeApp({ projectId: db.projectId }, "external-refresh-fixture");
});
afterAll(async () => {
  await boundary?.close();
  if (app) await firebaseAdminRuntime.deleteApp(app);
  if (directory) await rm(directory, { recursive: true, force: true });
});
let reportingRequests=0; let reportingOutage=false;
beforeEach(async () => {
  reportingRequests=0; reportingOutage=false;
  // Reset only this fixture's project, without BulkWriter's wall-clock limiter.
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  boundary.objects.clear();
  boundary.reject(null);
  boundary.refuseReads(false);
  now = Date.parse("2026-10-12T14:00:00Z");
  title = "Public provider story";
  outage = false;
  requests = 0;
  tvssRequests = 0;
  await db.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: release, activeGeneration: 1, activeDeploymentId: "fixture" });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
});
afterEach(() => vi.restoreAllMocks());
const fetchProvider = (async url => {
  requests++;
  if (outage) return new Response("private upstream error body must not enter a receipt", { status: 401 });
  if (String(url).includes("/wp-json/wp/v2/posts")) {
    reportingRequests++;
    if (reportingOutage) return new Response("PRIVATE upstream failure",{status:503});
    return Response.json([{id:42,link:"https://www.njspotlightnews.org/2026/10/wage-story/",date_gmt:"2026-10-11T12:00:00",title:{rendered:"Published wages"},tags:[25890],categories:[]}]);
  }
  if (String(url).includes("media.services.pbs.org")) return Response.json({ data: [{ id: "fixture-show", attributes: {
    title: "Painting Community", slug: "painting-community", description: "Public program", image: "https://image.pbs.org/fixture.jpg",
  } }] });
  if (String(url).includes("njspotlightnews.org")) return new Response(`<rss><channel><item><title>${title}</title><link>https://www.njspotlightnews.org/2026/10/public-story/</link><pubDate>Sun, 11 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`);
  if (String(url).startsWith("https://jaws.pbs.org/tvss/")) {
    tvssRequests++;
    return new Response(await readFile(new URL("../../site/tests/fixtures/tvss-wnjt-20260710.jsonp", import.meta.url), "utf8"));
  }
  throw new Error("Unexpected network destination");
}) as typeof fetch;
function owner() {
  return cloudExternalRefresh({ firestore: db, firebaseApp: app, runtime: { owner: "cloudflare", release },
    serializerId: "cloudflare-publisher", backgroundBucket: "fixture-bucket", stateDirectory: directory,
    buildEnvironment: {}, mediaManagerCredential: { key: "fixture-key", secret: "fixture-only-value" }, fetchImpl: fetchProvider, clock: () => now });
}

it("freezes provider bytes with readback and atomically advances context without any Post/admission", async () => {
  await owner()();
  const refresh = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data();
  expect(refresh).toMatchObject({ status: "verified", attempts: 1, checkedAt: now });
  const current = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  expect(current.revision).toBe(2);
  expect(Object.keys(current.externalInputs.files).sort()).toEqual(["launch-media-manager.json", "schedule.json", "spotlight-news.json"]);
  expect(current.externalInputs.schedulePacket).toMatchObject({ schemaVersion: 1,
    source: { operationId: current.externalInputs.operationId, runtime: { owner: "cloudflare", release },
      checkedAt: now, contentDigest: current.externalInputs.contentDigest,
      scheduleDigest: current.externalInputs.files["schedule.json"].digest } });
  const queue = (await db.doc(`cmsPublishQueue/${current.externalInputs.operationId}`).get()).data();
  expect(queue).toMatchObject({ status: "pending", transport: "public-context-no-build-v1", publicContext: { contextRevision: 2, reason: "provider-refresh" } });
  const restored = path.join(directory, "restored");
  await restoreCloudExternalInputs({ inputs: current.externalInputs, storage: storageModule.createPostBackgroundStorage("fixture-bucket", app), directory: restored });
  expect(JSON.parse(await readFile(path.join(restored, "spotlight-news.json"), "utf8")).cards[0].title).toBe(title);
  expect(requests).toBeGreaterThan(0);
  expect(tvssRequests).toBe(0);
  const count = requests;
  await owner()();
  expect(requests).toBe(count);
  now = refresh.nextAttemptAt;
  await owner()();
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision).toBe(2);
  title = "Updated public provider story";
  now = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data().nextAttemptAt;
  await owner()();
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision).toBe(3);
});

it.each(["verified", "failed", "fetching"])("preserves a legacy %s row until due when no mapping is published", async status => {
  // Production rows written before reporting mappings have no mappingDigest.
  const legacy = { schemaVersion: 1, runtime: { owner: "cloudflare", release },
    operationId: "L".repeat(20), status, attempts: 1, periodStartedAt: now,
    nextCheckAt: now + 30 * 60_000, nextAttemptAt: now + 10 * 60_000, checkedAt: now };
  await db.doc(state.EXTERNAL_REFRESH_PATH).set(legacy);
  const initialContext = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  await owner()();
  expect(requests).toBe(0);
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toEqual(legacy);
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual(initialContext);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);

  now = legacy.nextAttemptAt;
  await owner()();
  expect(requests).toBeGreaterThan(0);
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({
    status: "verified", mappingDigest: createHash("sha256").update("null").digest("hex"),
  });
});

it("keeps failure fixed and bounded, preserves prior context, and respects global pause", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  outage = true;
  await owner()();
  const failed = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data();
  expect(failed).toMatchObject({ status: "failed", attempts: 1, error: "external_refresh_failed", diagnostic: "provider" });
  expect(errorLog).toHaveBeenCalledWith("Cloud external refresh failed at provider");
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private upstream");
  expect(JSON.stringify(failed)).not.toContain("private upstream");
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision).toBe(1);
  const count = requests;
  await owner()();
  expect(requests).toBe(count);
  for (let attempt = 2; attempt <= 4; attempt++) {
    now = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data().nextAttemptAt;
    await owner()();
    expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({ status: "failed", attempts: attempt });
  }
  const exhausted = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data();
  const afterAttempts = requests;
  await owner()();
  expect(requests).toBe(afterAttempts);
  now = exhausted.nextAttemptAt;
  await owner()();
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({ status: "failed", attempts: 1 });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  const pausedCount = requests;
  now = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data().nextAttemptAt;
  await owner()();
  expect(requests).toBe(pausedCount);
});

it("records a safe seal failure without changing context or logging SDK details", async () => {
  boundary.reject(() => true);
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await owner()();
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({
    status: "failed", attempts: 1, error: "external_refresh_failed", diagnostic: "seal",
  });
  expect(errorLog.mock.calls).toEqual([["Cloud external refresh failed at seal"]]);
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
});

it("preserves the accepted schedule pair and clock on unchanged refresh and cold reads", async () => {
  await owner()();
  const original = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  const packet = structuredClone(original.externalInputs.schedulePacket);
  const exactJson = Buffer.from(boundary.objects.get(packet.files.json.key)!);
  const exactPdf = Buffer.from(boundary.objects.get(packet.files.pdf.key)!);
  now = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data().nextAttemptAt;
  await owner()();
  const current = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  expect(current).toEqual(original);
  const count = requests;
  const read = await readCloudSchedulePacket({ inputs: current.externalInputs, packet: current.externalInputs.schedulePacket,
    storage: storageModule.createPostBackgroundStorage("fixture-bucket", app) });
  expect(read.json.equals(exactJson)).toBe(true);
  expect(read.pdf.equals(exactPdf)).toBe(true);
  expect(requests).toBe(count);
  expect(current.externalInputs.schedulePacket).toEqual(packet);
});

it("initializes a missing pair in one successor while preserving the historical provider identity", async () => {
  await owner()();
  const original = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  delete original.externalInputs.schedulePacket;
  original.externalInputs.runtime.release = "e".repeat(40);
  await db.doc(context.PUBLIC_CONTEXT_PATH).set(original);
  now = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data().nextAttemptAt;
  await owner()();
  const current = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  const { schedulePacket, ...providerInputs } = current.externalInputs;
  expect(providerInputs).toEqual(original.externalInputs);
  expect(current.revision).toBe(original.revision + 1);
  expect(schedulePacket.source).toMatchObject({ operationId: original.externalInputs.operationId,
    runtime: original.externalInputs.runtime, checkedAt: original.externalInputs.checkedAt });
  const refresh = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data();
  expect(refresh).toMatchObject({ status: "verified", checkedAt: now });
  expect(refresh.operationId).not.toBe(providerInputs.operationId);
  const queue = (await db.doc(`cmsPublishQueue/${refresh.operationId}`).get()).data();
  expect(queue).toMatchObject({ transport: "public-context-no-build-v1", runtime: { owner: "cloudflare", release },
    publicContext: { contextRevision: current.revision, reason: "provider-refresh" } });
  const read = await readCloudSchedulePacket({ inputs: current.externalInputs, packet: schedulePacket,
    storage: storageModule.createPostBackgroundStorage("fixture-bucket", app) });
  expect(read.exported.exportedAt).toBe(new Date(original.externalInputs.checkedAt).toISOString());
  now = refresh.nextAttemptAt;
  await owner()();
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual(current);
});

it.each(["schedule.json", "nj-pbs-schedule.pdf"])("refuses context acceptance when packet %s readback changes", async filename => {
  boundary.reject(key => {
    if (key.includes("/schedule-packets/") && key.endsWith(`/${filename}`)) boundary.objects.set(key, Buffer.from("corrupt"));
    return false;
  });
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await owner()();
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({ status: "failed", diagnostic: "seal" });
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual({ schemaVersion: 1, revision: 1 });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
  expect(errorLog.mock.calls).toEqual([["Cloud external refresh failed at seal"]]);
});

it("never restores changed or foreign provider bytes under the accepted revision", async () => {
  await owner()();
  const inputs = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().externalInputs;
  const name = state.EXTERNAL_INPUT_FILES[0];
  const corrupt = { ...inputs, files: { ...inputs.files, [name]: { ...inputs.files[name], digest: "f".repeat(64) } } };
  await expect(restoreCloudExternalInputs({ inputs: corrupt, storage: storageModule.createPostBackgroundStorage("fixture-bucket", app), directory: path.join(directory, "corrupt") })).rejects.toThrow("digest changed");
});

it.each([
  ["2026-07-10T06:59:59.999-04:00", "2026-07-10T07:00:00-04:00"],
  ["2026-07-10T07:00:00-04:00", "2026-07-10T19:00:00-04:00"],
  ["2026-07-10T18:30:00-04:00", "2026-07-10T19:00:00-04:00"],
  ["2026-07-10T19:00:00-04:00", "2026-07-11T07:00:00-04:00"],
  ["2026-01-10T06:59:59.999-05:00", "2026-01-10T07:00:00-05:00"],
  ["2026-01-10T19:00:00-05:00", "2026-01-11T07:00:00-05:00"],
  ["2026-03-07T19:00:00-05:00", "2026-03-08T07:00:00-04:00"],
  ["2026-10-31T19:00:00-04:00", "2026-11-01T07:00:00-05:00"],
])("finds the next Eastern refresh slot after %s", (now, next) => {
  expect(state.nextExternalRefreshAt(Date.parse(now))).toBe(Date.parse(next));
});

it.each(["2026-07-10T00:00:00-04:00", "2026-01-10T00:00:00-05:00",
  "2026-03-08T00:00:00-05:00", "2026-11-01T00:00:00-04:00"])(
  "schedules exactly two refreshes at 07:00 and 19:00 on %s", day => {
    const format = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    let at = Date.parse(day);
    const slots = Array.from({ length: 2 }, () => { at = state.nextExternalRefreshAt(at); return format.format(at); });
    expect(slots).toEqual(["07:00", "19:00"]);
    const next = state.nextExternalRefreshAt(at);
    expect(format.format(next)).toBe("07:00");
    expect(next - at).toBe(12 * 3_600_000);
  },
);

it("retains late-evening and next-morning schedule listings after the 19:00 refresh", async () => {
  now = Date.parse("2026-07-10T19:00:00-04:00");
  await owner()();
  const current = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({
    status: "verified", nextAttemptAt: Date.parse("2026-07-11T07:00:00-04:00"),
  });
  const packet = await readCloudSchedulePacket({ inputs: current.externalInputs, packet: current.externalInputs.schedulePacket,
    storage: storageModule.createPostBackgroundStorage("fixture-bucket", app) });
  for (const kind of ["broadcast", "kids"] as const) {
    expect(packet.schedule.days[kind]).toHaveLength(14);
    const entries = packet.schedule.days[kind].flatMap(day => day.entries);
    // The recorded TVSS fixture has BBC News at 23:30 and Gods of Tennis at 01:00.
    const late = Date.parse("2026-07-10T23:45:00-04:00");
    const morning = Date.parse("2026-07-11T01:30:00-04:00");
    for (const instant of [late, morning]) {
      expect(entries.some(entry => Date.parse(entry.startsAt) <= instant && Date.parse(entry.endsAt) > instant)).toBe(true);
    }
  }
});

it("refreshes a non-curated schedule clock through all 28 recorded TVSS responses", async () => {
  now = Date.parse("2026-07-10T14:00:00Z");
  await owner()();
  expect(tvssRequests).toBe(28);
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({ status: "verified", attempts: 1 });
  const current = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
  expect(current.revision).toBe(2);
  const restored = path.join(directory, "tvss-restored");
  await restoreCloudExternalInputs({ inputs: current.externalInputs, storage: storageModule.createPostBackgroundStorage("fixture-bucket", app), directory: restored });
  const schedule = JSON.parse(await readFile(path.join(restored, "schedule.json"), "utf8"));
  expect(schedule.days.broadcast).toHaveLength(14);
  expect(schedule.days.kids).toHaveLength(14);
});

it("wakes the existing owner on a published mapping change and retains only the exact failed query",async()=>{
  await owner()();expect(reportingRequests).toBe(0);
  // The first published mapping must wake a production row without a digest.
  const { mappingDigest: _digest, ...legacy } = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()!;
  await db.doc(state.EXTERNAL_REFRESH_PATH).set(legacy);
  const mapping={...reportingContract.emptyReportingMapping(),spotlight:{tags:[{id:25890,slug:"minimum-wage",label:"Minimum wage"}],categories:[]}};
  const config={...reportingContract.emptyDataHubReporting(),figures:{minimumwage:mapping}};
  await db.doc("cmsPages/data-hub").set({status:"published",publiclyVisible:true,publishAt:new Date(now).toISOString(),
    published:{metadata:{dataHubReporting:config},publishedAt:new Date(now).toISOString()}});
  const load=async()=>{
    const inputs=(await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()!.externalInputs;
    expect(Object.keys(inputs.files)).toHaveLength(3);
    return reportingInput.readRetainedReporting({inputs,read:(key:string)=>storageModule.createPostBackgroundStorage("fixture-bucket",app).get(key)});
  };
  await owner()();expect(reportingRequests).toBe(1);
  const good=await load();const key=reportingSources.reportingQueryKey(mapping);
  expect(good.queries[key].stories).toMatchObject([{id:"42",title:"Published wages"}]);
  const checkedAt=good.queries[key].checkedAt;
  reportingOutage=true;now=(await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()!.nextAttemptAt;
  await owner()();
  expect((await load()).queries[key]).toMatchObject({failed:true,checkedAt,stories:[{id:"42"}]});
  const changed={...config,figures:{minimumwage:{...mapping,spotlight:{tags:[{id:77,slug:"other-wages",label:"Other wages"}],categories:[]}}}};
  await db.doc("cmsPages/data-hub").update({"published.metadata.dataHubReporting":changed});
  await owner()();
  const replacement=await load();
  expect(replacement.queries[key]).toBeUndefined();
  expect(replacement.queries[reportingSources.reportingQueryKey(changed.figures.minimumwage)]).toMatchObject({failed:true,checkedAt:null,stories:[]});
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()!.status).toBe("verified");
});

it("change-log: commits provider, Schedule and Data Hub members with one external acceptance", async () => {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "fixture", activeCommitSha: release, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture" });
  await enrollPublicReleaseLog(db, release);
  await owner()();
  const current = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()!;
  const [entry] = await publicReleaseEntries(db);
  expect(entry.operationId).toBe(current.externalInputs.operationId);
  expect(entry.contextRevision).toBe(2);
  expect(entry.changes.map(change => change.kind)).toEqual(["dataHub", "provider", "schedule"]);
  const packet = current.externalInputs.schedulePacket;
  expect(packet.files.pdf.digest).toMatch(/^[a-f0-9]{64}$/);
  now = (await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()!.nextAttemptAt;
  await owner()();
  expect(await publicReleaseEntries(db)).toHaveLength(1);
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()!.externalInputs.schedulePacket).toEqual(packet);
});
it("change-log: a refused log append leaves provider context and queue unchanged", async () => {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "fixture", activeCommitSha: release, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture" });
  await enrollPublicReleaseLog(db, release);
  await db.doc("system/publicReleaseChanges").delete();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await owner()();
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual({ schemaVersion: 1, revision: 1 });
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.doc(state.EXTERNAL_REFRESH_PATH).get()).data()).toMatchObject({ status: "failed", diagnostic: "accept" });
  expect(errorLog).toHaveBeenCalledWith("Cloud external refresh failed at accept");
});

// The administrative writer changes only hold with the observed updateTime.
it.each(["due", "successor runtime", "mapping change"])("honors a CAS release hold across %s and resumes at expiry", async reason => {
  const ref = db.doc(state.EXTERNAL_REFRESH_PATH);
  const until = now + 60_000;
  const previous = { schemaVersion: 1, runtime: { owner: "cloudflare", release: reason === "successor runtime" ? "e".repeat(40) : release },
    operationId: "P".repeat(20), status: "verified", attempts: 1, periodStartedAt: now - 1000, checkedAt: now - 1000,
    nextAttemptAt: reason === "due" ? now : now + 3_600_000, nextCheckAt: now + 3_600_000 };
  await ref.set(previous);
  if (reason === "mapping change") {
    const mapping = { ...reportingContract.emptyReportingMapping(), spotlight: { tags: [{ id: 25890, slug: "minimum-wage", label: "Minimum wage" }], categories: [] } };
    const config = { ...reportingContract.emptyDataHubReporting(), figures: { minimumwage: mapping } };
    await db.doc("cmsPages/data-hub").set({ status: "published", publiclyVisible: true, publishAt: new Date(now).toISOString(),
      published: { metadata: { dataHubReporting: config }, publishedAt: new Date(now).toISOString() } });
  }
  const observed = await ref.get();
  const hold = { operationId: "H".repeat(20), startedAt: now, until };
  await ref.update({ hold }, { lastUpdateTime: observed.updateTime! });
  const held = await ref.get();
  expect(state.externalRefreshDue(held.data(), { owner: "cloudflare", release }, now)).toBe(false);
  await owner()();
  expect(requests).toBe(0);
  expect((await ref.get()).updateTime!.isEqual(held.updateTime!)).toBe(true);
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual({ schemaVersion: 1, revision: 1 });
  now = until;
  await owner()();
  expect(requests).toBeGreaterThan(0);
  expect((await ref.get()).data()).toMatchObject({ status: "verified", runtime: { owner: "cloudflare", release }, hold });
});

it("refuses a stale hold update when the provider writer changed the scheduler", async () => {
  const ref = db.doc(state.EXTERNAL_REFRESH_PATH);
  await owner()();
  const observed = await ref.get();
  now = observed.data()!.nextAttemptAt;
  await owner()();
  const latest = await ref.get();
  await expect(ref.update({ hold: { operationId: "H".repeat(20), startedAt: now, until: now + 60_000 } },
    { lastUpdateTime: observed.updateTime! })).rejects.toMatchObject({ code: 9 });
  expect((await ref.get()).data()).toEqual(latest.data());
});

it.each(["invalid", {}, { operationId: "H".repeat(20), until: "later" }, { operationId: "H".repeat(20), until: 1, extra: true }])(
  "refuses a malformed hold without provider work", async hold => {
    await db.doc(state.EXTERNAL_REFRESH_PATH).set({ schemaVersion: 1, runtime: { owner: "cloudflare", release },
      status: "verified", nextAttemptAt: now, hold });
    await expect(owner()()).rejects.toThrow("Invalid external refresh hold");
    expect(requests).toBe(0);
  },
);

it.each([12 * 3_600_000, 12 * 3_600_000 + 1])("bounds a release hold duration of %s milliseconds", async duration => {
  const ref = db.doc(state.EXTERNAL_REFRESH_PATH);
  const hold = { operationId: "H".repeat(20), startedAt: now, until: now + duration };
  await ref.set({ schemaVersion: 1, runtime: { owner: "cloudflare", release }, operationId: "P".repeat(20),
    status: "verified", nextAttemptAt: now, nextCheckAt: now, checkedAt: now, hold });
  await owner()();
  if (duration === 12 * 3_600_000) {
    expect(requests).toBe(0);
    expect((await ref.get()).data()!.hold).toEqual(hold);
  } else {
    expect(requests).toBeGreaterThan(0);
    expect((await ref.get()).data()).toMatchObject({ status: "verified", hold: null });
  }
});

it.each([
  [1000, 3_600_000, true],
  [5 * 60_000, 12 * 3_600_000, true],
  [5 * 60_000 + 1, 12 * 3_600_000, false],
  [365 * 24 * 3_600_000, 3_600_000, false],
] as const)("bounds hold clock skew %s and duration %s", async (offset, duration, held) => {
  const ref = db.doc(state.EXTERNAL_REFRESH_PATH);
  const hold = { operationId: "H".repeat(20), startedAt: now + offset, until: now + offset + duration };
  await ref.set({ schemaVersion: 1, runtime: { owner: "cloudflare", release }, operationId: "P".repeat(20),
    status: "verified", nextAttemptAt: now, nextCheckAt: now, checkedAt: now, hold });
  await owner()();
  expect(requests > 0).toBe(!held);
  expect((await ref.get()).data()!.hold).toEqual(held ? hold : null);
});
