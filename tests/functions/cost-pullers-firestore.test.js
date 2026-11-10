import admin from "../helpers/firebase-admin.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import store from "../../functions/lib/cost-ledger-store.js";
import ledger from "../../functions/lib/cost-ledger.js";
import { createCostLedgerRefreshRunner } from "../../functions/cost-ledger-refresh.js";

const PROJECT = "demo-njpbs";
const PERIOD = "2026-09";
const NOW = "2026-09-15T15:00:00.000Z";
const LINES = ["aws-lightsail", "aws-other", "aws-s3", "manual-target", "hardware-target", "github-actions", "github-other"];
let db;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("Use the Firestore emulator for cost puller transaction tests.");
  }
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});

afterEach(async () => {
  await Promise.all([
    ...LINES.map((id) => db.collection("costLedgerLines").doc(id).delete()),
    db.collection("costLedgerPeriods").doc(PERIOD).delete(),
    db.collection("costLedgerPeriods").doc("2026-08").delete(),
    db.collection("costLedgerPeriods").doc("2026-11").delete(),
    db.collection("costLedgerSnapshots").doc("2026-09-15").delete(),
  ]);
});

describe("automatic close stored-entry checks", () => {
  async function refresh(log = { info() {} }) {
    for (const id of ["aws-s3", "github-actions", "github-other"]) {
      await db.collection("costLedgerLines").doc(id).set({
        label: id, source: "auto", autoKey: id, category: "cloud", enabled: true,
        freshnessStatus: "disabled", freshnessAt: null,
      });
    }
    return createCostLedgerRefreshRunner({
      firestore: db, now: () => new Date(NOW), flags: { COST_LEDGER_GITHUB_PULL: true },
      env: { COST_LEDGER_GITHUB_TOKEN: "fixture", COST_LEDGER_GITHUB_ACCOUNT: "CenterCoopMedia", COST_LEDGER_GITHUB_ACCOUNT_TYPE: "org" },
      clients: { github: async () => ({ usageItems: [] }) }, log,
    })();
  }

  it("closes with a manual override and keeps the current override freshness manual", async () => {
    for (const period of ["2026-08", PERIOD]) {
      await db.collection("costLedgerPeriods").doc(period).set({
        period, status: "open", entries: { "aws-s3": { source: "manual", amountCents: 0 }, "github-actions": { source: "manual", amountCents: 999 } },
      });
    }
    const result = await refresh();
    expect(result.closed.changed).toBe(true);
    expect(result.results.find(({ id }) => id === "github").status).toBe("fresh");
    expect((await store.loadPeriod(db, PERIOD)).entries["github-actions"]).toEqual({ source: "manual", amountCents: 999 });
    expect((await db.collection("costLedgerLines").doc("github-actions").get()).data().freshnessStatus).toBe("manual");
  });

  it.each([
    ["2026-08-15T15:00:00.000Z", false, false],
    ["2026-09-01T03:59:59.999Z", false, false],
    ["2026-09-01T04:00:00.000Z", false, true],
    ["2026-09-02T00:00:00.000Z", true, false],
    [null, false, false],
    ["not-a-date", false, false],
  ])("checks disabled provider entry at %s estimated=%s", async (pulledAt, estimated, closes) => {
    await db.collection("costLedgerPeriods").doc("2026-08").set({
      period: "2026-08", status: "open", entries: {
        "aws-s3": { source: "auto", amountCents: 125, pulledAt, estimated },
      },
    });
    const log = { info: vi.fn() };
    const result = await refresh(log);
    expect(result.closed.changed).toBe(closes);
    expect((await store.loadPeriod(db, "2026-08")).status).toBe(closes ? "closed" : "open");
    if (!closes) {
      const blocked = { reason: "stale-or-estimated", lineIds: ["aws-s3"] };
      expect(result.closed.blocked).toEqual(blocked);
      expect(log.info).toHaveBeenCalledWith("cost ledger refresh completed", {
        period: PERIOD, closedPrevious: false, closeBlocked: blocked,
        pullers: result.results.map(({ id, status }) => ({ id, status })),
      });
      const manual = await store.closeMonth(db, "2026-08", { uid: "admin", source: "test" }, NOW);
      expect(manual.changed).toBe(true);
      expect(Object.keys(manual).sort()).toEqual(["after", "before", "changed"]);
    }
  });

  it.each(["deleted", "disabled", "enabled", "default enabled"])(
    "checks only frozen lines when the stale line is %s", async (state) => {
      if (state !== "deleted") {
        await db.collection("costLedgerLines").doc("aws-s3").set({
          source: "auto", autoKey: "aws-s3", category: "cloud",
          ...(state === "default enabled" ? {} : { enabled: state === "enabled" }),
        });
      }
      await db.collection("costLedgerPeriods").doc("2026-08").set({
        period: "2026-08", status: "open", entries: {
          "aws-s3": { source: "auto", amountCents: 125, pulledAt: "2026-08-15T15:00:00.000Z" },
        },
      });
      const result = await store.closeMonth(db, "2026-08", { uid: "scheduler" }, NOW, {
        onlyIfExists: true, respectSchedulerBlock: true,
      });
      const closes = state === "deleted" || state === "disabled";
      expect(result.changed).toBe(closes);
      if (closes) {
        expect(result.after.entries).toEqual({});
        expect(result.blocked).toBeUndefined();
      } else {
        expect(result.blocked).toEqual({ reason: "stale-or-estimated", lineIds: ["aws-s3"] });
      }
      expect((await store.loadPeriod(db, "2026-08")).status).toBe(closes ? "closed" : "open");
    },
  );

  it.each([
    ["2026-12-01T04:59:59.999Z", false],
    ["2026-12-01T05:00:00.000Z", true],
  ])("checks the November EST boundary at %s", async (pulledAt, closes) => {
    await db.collection("costLedgerLines").doc("aws-s3").set({ source: "auto", enabled: true });
    await db.collection("costLedgerPeriods").doc("2026-11").set({
      period: "2026-11", status: "open", entries: {
        "aws-s3": { source: "auto", amountCents: 125, pulledAt, estimated: false },
      },
    });
    const result = await store.closeMonth(db, "2026-11", { uid: "scheduler" }, "2026-12-08T15:00:00.000Z", {
      onlyIfExists: true, respectSchedulerBlock: true,
    });
    expect(result.changed).toBe(closes);
    expect(result.blocked).toEqual(closes ? undefined : { reason: "stale-or-estimated", lineIds: ["aws-s3"] });
    expect((await store.loadPeriod(db, "2026-11")).status).toBe(closes ? "closed" : "open");
  });

  it("blocks an absent automatic entry when only another provider is on", async () => {
    await db.collection("costLedgerPeriods").doc("2026-08").set({
      period: "2026-08", status: "open", entries: {},
    });
    const result = await refresh();
    expect(result.closed.blocked).toEqual({ reason: "missing", lineIds: ["aws-s3"] });
    expect((await store.loadPeriod(db, "2026-08")).status).toBe("open");
  });

  it("prioritizes missing lines over stale and estimated lines", async () => {
    for (const id of ["aws-s3", "aws-other", "aws-lightsail", "github-actions"]) {
      await db.collection("costLedgerLines").doc(id).set({ source: "auto", enabled: true });
    }
    await db.collection("costLedgerPeriods").doc("2026-08").set({
      period: "2026-08", status: "open", entries: {
        "aws-lightsail": { source: "auto", amountCents: 125, pulledAt: "2026-08-15T15:00:00.000Z", estimated: false },
        "github-actions": { source: "auto", amountCents: 125, pulledAt: NOW, estimated: true },
      },
    });
    const result = await store.closeMonth(db, "2026-08", "scheduler", NOW, { respectSchedulerBlock: true });
    expect(result.changed).toBe(false);
    expect(result.blocked).toEqual({ reason: "missing", lineIds: ["aws-other", "aws-s3"] });
    expect((await store.loadPeriod(db, "2026-08")).status).toBe("open");
  });

  it.each([
    [null, false], [-1, true], [1.5, false], ["100", false], [0, true], [125, true],
    [-ledger.MAX_CENTS, true], [ledger.MAX_CENTS, true],
    [-ledger.MAX_CENTS - 1, false], [ledger.MAX_CENTS + 1, false],
  ])("checks manual override amount %s in both guards", async (amountCents, valid) => {
    await db.collection("costLedgerLines").doc("aws-s3").set({ source: "auto", autoKey: "aws-s3" });
    await db.collection("costLedgerPeriods").doc("2026-08").set({
      period: "2026-08", status: "open", entries: { "aws-s3": { source: "manual", amountCents } },
    });
    if (amountCents === null) {
      await store.savePeriodAmount(db, { period: "2026-08", lineId: "aws-s3", amountCents: null }, "admin", NOW);
    }
    const written = await store.writeAutomaticPeriod(db, "2026-08", [{ lineId: "aws-s3", amountCents: 100 }], NOW);
    expect(written.manualLineIds).toEqual(valid ? ["aws-s3"] : []);
    const closed = await store.closeMonth(db, "2026-08", "scheduler", NOW, { respectSchedulerBlock: true });
    expect(closed.changed).toBe(valid);
    expect(closed.blocked).toEqual(valid ? undefined : { reason: "missing", lineIds: ["aws-s3"] });
    if (!valid) expect((await store.closeMonth(db, "2026-08", "admin", NOW)).changed).toBe(true);
  });

  it("does not require period entries for manual standing lines even with an autoKey", async () => {
    await db.collection("costLedgerLines").doc("manual-target").set({
      source: "manual", autoKey: "manual-target", cadence: "monthly", amountCents: 500, enabled: true,
    });
    await db.collection("costLedgerPeriods").doc("2026-08").set({ period: "2026-08", status: "open", entries: {} });
    const result = await store.closeMonth(db, "2026-08", "scheduler", NOW, { respectSchedulerBlock: true });
    expect(result.changed).toBe(true);
    expect(result.after.entries["manual-target"].amountCents).toBe(500);
  });

  it.each(["all manual", "one automatic", "deleted", "disabled", "all deleted", "all disabled", "blank manual"])(
    "uses kept eligible values when the provider is %s", async (mode) => {
      const ids = ["aws-s3", "aws-lightsail", "aws-other"];
      const entries = {};
      for (const id of ids) {
        if (mode !== "all deleted" && !(mode === "deleted" && id === "aws-other")) {
          await db.collection("costLedgerLines").doc(id).set({
            label: id, source: "auto", autoKey: id, category: "cloud",
            enabled: mode !== "all disabled" && !(mode === "disabled" && id === "aws-other"),
          });
        }
        if (mode === "all manual" || mode === "blank manual" || (mode === "one automatic" && id !== "aws-other")) {
          entries[id] = { source: "manual", amountCents: mode === "blank manual" ? null : 0 };
        }
      }
      for (const period of ["2026-08", PERIOD]) {
        await db.collection("costLedgerPeriods").doc(period).set({ period, status: "open", entries });
      }
      const estimated = ["all manual", "one automatic"].includes(mode);
      const result = await createCostLedgerRefreshRunner({
        firestore: db, now: () => new Date(NOW), flags: { COST_LEDGER_AWS_PULL: true },
        env: { COST_LEDGER_AWS_ACCESS_KEY_ID: "fixture", COST_LEDGER_AWS_SECRET_ACCESS_KEY: "fixture" },
        clients: { aws: async () => ({ ResultsByTime: [{ Estimated: estimated, Groups: [] }] }) },
        log: { info() {} },
      })();
      expect(result.closed.changed).toBe(!["one automatic", "blank manual"].includes(mode));
      expect(result.results.find(({ id }) => id === "aws").status).toBe(mode === "blank manual" ? "error" : "fresh");
      if (mode === "one automatic") {
        expect(result.closed.blocked).toEqual({ reason: "stale-or-estimated", lineIds: ["aws-other"] });
      }
      if (mode === "deleted" || mode === "disabled") expect(result.closed.after.entries["aws-other"]).toBeUndefined();
      if (mode === "all deleted" || mode === "all disabled") expect(result.closed.after.entries).toEqual({});
    },
  );

  it("persists estimates and clears the flag when a final pull replaces them", async () => {
    await db.collection("costLedgerLines").doc("aws-s3").set({ source: "auto", autoKey: "aws-s3", category: "cloud" });
    await store.writeAutomaticPeriod(db, PERIOD, [{ lineId: "aws-s3", amountCents: 125, estimated: true }], NOW);
    expect((await store.loadPeriod(db, PERIOD)).entries["aws-s3"].estimated).toBe(true);
    await store.writeAutomaticPeriod(db, PERIOD, [{ lineId: "aws-s3", amountCents: 150 }], NOW);
    expect((await store.loadPeriod(db, PERIOD)).entries["aws-s3"].estimated).toBe(false);
  });
});

describe("cost puller Firestore writes", () => {
  it("updates only the matching automatic line in one emulator transaction", async () => {
    await db.collection("costLedgerLines").doc("aws-s3").set({
      source: "auto", autoKey: "aws-s3", category: "cloud", freshnessStatus: "disabled", freshnessAt: null,
    });
    await db.collection("costLedgerLines").doc("manual-target").set({
      source: "manual", autoKey: "manual-target", category: "cloud", freshnessStatus: "manual", freshnessAt: null,
    });
    await db.collection("costLedgerLines").doc("hardware-target").set({
      source: "auto", autoKey: "hardware-target", category: "hardware", freshnessStatus: "manual", freshnessAt: null,
    });

    await store.writeAutomaticPeriod(db, PERIOD, [
      { lineId: "aws-s3", amountCents: 125 },
      { lineId: "manual-target", amountCents: 999 },
      { lineId: "hardware-target", amountCents: 999 },
    ], NOW);
    await store.writeLineFreshness(db, "aws-s3", "fresh", NOW);
    await store.writeLineFreshness(db, "manual-target", "fresh", NOW);
    await store.writeLineFreshness(db, "hardware-target", "fresh", NOW);

    const [period, automatic, manual, hardware] = await Promise.all([
      db.collection("costLedgerPeriods").doc(PERIOD).get(),
      db.collection("costLedgerLines").doc("aws-s3").get(),
      db.collection("costLedgerLines").doc("manual-target").get(),
      db.collection("costLedgerLines").doc("hardware-target").get(),
    ]);
    expect(period.data().entries).toEqual({
      "aws-s3": { amountCents: 125, source: "auto", pulledAt: NOW, estimated: false },
    });
    expect(automatic.data()).toMatchObject({ freshnessStatus: "fresh", freshnessAt: NOW });
    expect(manual.data()).toMatchObject({ freshnessStatus: "manual", freshnessAt: null });
    expect(hardware.data()).toMatchObject({ freshnessStatus: "manual", freshnessAt: null });
  });
});
