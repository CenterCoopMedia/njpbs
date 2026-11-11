// @vitest-environment node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { firebaseAdminRuntime } from "../scripts/firebase-admin-runtime";
import { backgroundStorageFixture } from "../../tests/functions/background-storage-fixture";
import { createCloudSchedulePacket, readCloudSchedulePacket } from "../scripts/cloud-schedule-packet";
import type { PreparedHomeExternalInputs } from "../src/lib/no-build-home-sources";

const require = createRequire(import.meta.url);
const { createPostBackgroundStorage } = require("../../functions/lib/post-background-storage");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const dates = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
  "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];
const frozenClock = Date.parse("2026-10-30T15:00:00.000Z");
const dataset = () => ({ source: "pbs-tvss", generatedAt: "2026-10-30T13:00:00.000Z", timeZone: "America/New_York",
  request: { station: "WNJT", dates }, days: Object.fromEntries(["broadcast", "kids"].map(kind => [kind, dates.map(date => ({
    date, callsign: "wnjt", kind, feedCid: `fixture-${kind}`, timeZone: "America/New_York",
    sourceCheckedAt: "2026-10-30T12:00:00.000Z", entries: [{ title: `${kind} fixture ${date}`,
      startsAt: `${date}T12:00:00${date < "2026-11-01" ? "-04:00" : "-05:00"}`,
      endsAt: `${date}T13:00:00${date < "2026-11-01" ? "-04:00" : "-05:00"}`,
      seasonNumber: null, episodeNumber: null, nolaRoot: null, programId: null, programExternalId: null, cid: null,
      isKids: kind === "kids", kids: kind === "kids", feedKind: kind }],
  }))])) });
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let storage: ReturnType<typeof createPostBackgroundStorage>;
let inputs: PreparedHomeExternalInputs;
beforeAll(async () => {
  boundary = await backgroundStorageFixture("schedule-packet-fixture");
  app = firebaseAdminRuntime.initializeApp({ projectId: "demo-njpbs" }, "cloud-schedule-packet");
  storage = createPostBackgroundStorage("schedule-packet-fixture", app);
});
afterAll(async () => { await boundary?.close(); if (app) await firebaseAdminRuntime.deleteApp(app); });
beforeEach(() => {
  boundary.objects.clear(); boundary.reads.length = 0; boundary.writes.length = 0;
  boundary.reject(null); boundary.refuseReads(false);
  inputs = { schemaVersion: 1, operationId: "S".repeat(20), runtime: { owner: "cloudflare", release: "a".repeat(40) },
    contentDigest: "b".repeat(64), checkedAt: frozenClock, files: {} };
  for (const name of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) {
    const bytes = Buffer.from(JSON.stringify(name === "schedule.json" ? dataset() : {}));
    const key = `post-background-v1/external-inputs/${inputs.operationId}/${name}`;
    boundary.objects.set(key, bytes);
    inputs.files[name] = { key, digest: hash(bytes), size: bytes.length };
  }
});

it("seals and reads an exact JSON/PDF pair with the frozen clock and 14-day DST window", async () => {
  const before = structuredClone(inputs);
  const packet = await createCloudSchedulePacket({ inputs, storage });
  expect(inputs).toEqual(before);
  expect(Object.keys(inputs.files)).toHaveLength(3);
  expect(packet).toMatchObject({ schemaVersion: 1, startDate: "2026-10-30", endDate: "2026-11-12",
    exportedAt: "2026-10-30T15:00:00.000Z", generatedAt: "2026-10-30T13:00:00.000Z" });
  const read = await readCloudSchedulePacket({ inputs, packet, storage });
  expect(read.exported.dates).toEqual(dates);
  expect(read.schedule.days.broadcast.some(day => day.date === "2026-11-01" &&
    day.entries[0]?.startsAt === "2026-11-01T00:00:00-04:00" &&
    day.entries.some(entry => entry.startsAt === "2026-11-01T02:00:00-05:00"))).toBe(true);
  expect(read.pdf.subarray(0, 8).toString()).toBe("%PDF-1.7");
  const document = read.pdf.toString("latin1");
  const reference = /\/CreationDate (\d+) 0 R/.exec(document);
  expect(reference).not.toBeNull();
  const metadataDate = new RegExp(`${reference![1]} 0 obj\\s*\\(([^)]+)\\)`).exec(document)?.[1];
  expect(metadataDate).toBe("D:20261030150000Z");
  expect(boundary.writes).toEqual([packet.files.json.key, packet.files.pdf.key]);
  for (const file of Object.values(packet.files)) {
    const bytes = boundary.objects.get(file.key)!;
    expect(bytes.length).toBe(file.size); expect(hash(bytes)).toBe(file.digest);
    expect(boundary.reads).toContain(file.key);
  }
  const reordered = { ...packet, source: { ...packet.source, runtime: { release: inputs.runtime.release, owner: "cloudflare" as const } } };
  expect((await readCloudSchedulePacket({ inputs, packet: reordered, storage })).pdf.equals(read.pdf)).toBe(true);
});
it("restores the exact retained pair without regenerating PDF bytes", async () => {
  const first = await createCloudSchedulePacket({ inputs, storage });
  const retained = new Map([...boundary.objects].map(([key, bytes]) => [key, Buffer.from(bytes)]));
  const restored = await readCloudSchedulePacket({ inputs, packet: structuredClone(first), storage });
  expect(restored.json.equals(retained.get(first.files.json.key)!)).toBe(true);
  expect(restored.pdf.equals(retained.get(first.files.pdf.key)!)).toBe(true);
  expect([...boundary.objects.keys()].sort()).toEqual([...retained.keys()].sort());
  for (const [key, bytes] of retained) expect(boundary.objects.get(key)!.equals(bytes)).toBe(true);
  expect(boundary.writes).toEqual([first.files.json.key, first.files.pdf.key]);
  expect(restored.exported.dates).toEqual(dates);
});
it("refuses input digest changes before producing either output", async () => {
  boundary.objects.set(inputs.files["schedule.json"].key, Buffer.from("{}"));
  await expect(createCloudSchedulePacket({ inputs, storage })).rejects.toThrow();
  expect(boundary.writes).toEqual([]);
});
it.each(["broadcast", "kids"] as const)("refuses an empty %s day before sealing either output", async kind => {
  const invalid = dataset();
  invalid.days[kind][0].entries = [];
  const bytes = Buffer.from(JSON.stringify(invalid));
  const file = inputs.files["schedule.json"];
  boundary.objects.set(file.key, bytes);
  file.digest = hash(bytes);
  file.size = bytes.length;
  await expect(createCloudSchedulePacket({ inputs, storage })).rejects.toThrow("Cloud schedule packet is unavailable");
  expect(boundary.writes).toEqual([]);
});
it("returns no receipt when immutable output readback fails", async () => {
  boundary.reject(key => { if (key.includes("/schedule-packets/")) boundary.objects.set(key, Buffer.from("corrupt")); return false; });
  await expect(createCloudSchedulePacket({ inputs, storage })).rejects.toThrow();
});
it("refuses a swapped PDF, unknown object key, foreign source and changed clock", async () => {
  const packet = await createCloudSchedulePacket({ inputs, storage });
  for (const changed of [
    { ...packet, source: { ...packet.source, checkedAt: frozenClock + 1 } },
    { ...packet, source: { ...packet.source, runtime: { ...packet.source.runtime, release: "c".repeat(40) } } },
    { ...packet, files: { ...packet.files, pdf: { ...packet.files.pdf, key: "post-background-v1/other.pdf" } } },
  ]) await expect(readCloudSchedulePacket({ inputs, packet: changed, storage })).rejects.toThrow();
  boundary.objects.set(packet.files.pdf.key, Buffer.from("%PDF-swapped"));
  await expect(readCloudSchedulePacket({ inputs, packet, storage })).rejects.toThrow();
});
it("refuses a future bake clock before any writes", async () => {
  inputs.checkedAt = Date.parse("2026-10-30T12:59:59.000Z");
  await expect(createCloudSchedulePacket({ inputs, storage })).rejects.toThrow();
  expect(boundary.writes).toEqual([]);
});
