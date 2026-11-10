import { beforeEach, describe, expect, it, vi } from "vitest";
import ledger from "../../functions/lib/cost-ledger.js";
import store from "../../functions/lib/cost-ledger-store.js";
import { createCmsCostLedgerHandler } from "../../functions/cost-ledger.js";

const {
  SEED_COMPARISONS,
  SEED_LINES,
  SEED_MACHINES,
  applyAutoEntries,
  buildCsv,
  buildView,
  dateKey,
  freezePeriod,
  formatUsdPlain,
  hardwareMonthlyCents,
  periodFor,
  previousPeriod,
  usdToCents,
  validateComparisonInput,
  validateHardwareInput,
} = ledger;

function cloneStored(value) {
  if (Array.isArray(value)) return value.map((item) => cloneStored(item));
  if (!value || typeof value !== "object") return value;
  if (value.constructor && value.constructor.name !== "Object") return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = cloneStored(item);
  return copy;
}

function memoryDb() {
  const docs = new Map();
  const database = {
    collection(name) {
      return {
        doc(id) {
          const path = `${name}/${id}`;
          return {
            async get() {
              if (!docs.has(path)) return { exists: false, id, data: () => undefined };
              return { exists: true, id, data: () => cloneStored(docs.get(path)) };
            },
            async set(value) {
              docs.set(path, cloneStored(value));
            },
          };
        },
        async get() {
          const prefix = `${name}/`;
          const found = [];
          for (const [path, value] of docs) {
            if (!path.startsWith(prefix)) continue;
            const id = path.slice(prefix.length);
            if (id.includes("/")) continue;
            found.push({ id, data: () => cloneStored(value) });
          }
          return { docs: found, empty: found.length === 0 };
        },
      };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return ref.get();
        },
        set(ref, data) {
          return ref.set(data);
        },
      });
    },
  };
  return database;
}

function hardwareInput(overrides = {}) {
  return {
    machines: SEED_MACHINES.map((machine) => ({
      id: machine.id,
      label: machine.label,
      purchaseCents: null,
      lifeMonths: null,
      watts: null,
      hoursPerMonth: null,
      centsPerKwh: null,
      internetShareCents: null,
      ...(overrides[machine.id] || {}),
    })),
  };
}

async function auditRows(db) {
  const snap = await db.collection("admin_logs").get();
  return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

function user(role) {
  return {
    uid: "user-1",
    email: "user@example.org",
    principal: { id: "user-1", grants: [{ role }] },
  };
}

function response() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.set = () => res;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

function request(body) {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-firebase-appcheck": "token" },
    rawBody: Buffer.from(JSON.stringify(body)),
    ip: "203.0.113.17",
  };
}

describe("cost ledger amounts and periods", () => {
  it("converts dollar text to cents without binary drift", () => {
    expect(usdToCents("20.99")).toBe(2099);
    expect(usdToCents("0.005")).toBe(1);
    expect(usdToCents("-1.50")).toBe(-150);
    expect(usdToCents("0")).toBe(0);
    expect(formatUsdPlain(-150)).toBe("-1.50");
    expect(formatUsdPlain(null)).toBe("");
  });

  it("resolves America/New_York periods", () => {
    expect(periodFor(new Date("2026-09-01T03:30:00Z"))).toBe("2026-08");
    expect(periodFor(new Date("2026-09-15T15:00:00Z"))).toBe("2026-09");
    expect(dateKey(new Date("2026-09-15T15:00:00Z"))).toBe("2026-09-15");
    expect(previousPeriod("2026-01")).toBe("2025-12");
  });

  it("keeps blank amounts out of totals and annual lines as twelfths", () => {
    const lines = [
      { id: "claude", label: "Claude", category: "ai", project: "tooling", source: "manual", cadence: "annual", amountCents: 12000, enabled: true, vendor: "Anthropic", notes: "", freshnessStatus: "manual" },
      { id: "kimi", label: "Kimi", category: "ai", project: "tooling", source: "manual", cadence: "monthly", amountCents: null, enabled: true, vendor: "", notes: "", freshnessStatus: "blank" },
      { id: "aws-s3", label: "AWS S3", category: "cloud", project: "cms", source: "auto", cadence: "monthly", amountCents: null, enabled: true, vendor: "Amazon Web Services", notes: "", freshnessStatus: "fresh" },
    ];
    const rollup = buildView({
      lines,
      periods: [{ id: "2026-09", status: "open", entries: { "aws-s3": { amountCents: 0, source: "auto" } } }],
      snapshots: [],
      comparisons: [],
      period: "2026-09",
    });
    expect(rollup.monthlyCents).toBe(1000);
    expect(rollup.annualRunRateCents).toBe(12000);
    expect(rollup.blankLineCount).toBe(1);
    expect(rollup.knownLineCount).toBe(2);
    expect(rollup.byCategory.ai).toBe(1000);
    expect(rollup.byCategory.cloud).toBe(0);
  });

  it("keeps an explicit blank month amount blank while that month is open", () => {
    const lines = [
      { id: "claude", label: "Claude", category: "ai", project: "tooling", source: "manual", cadence: "monthly", amountCents: 1200, enabled: true, vendor: "", notes: "", freshnessStatus: "manual" },
    ];
    const view = buildView({
      lines,
      periods: [{ id: "2026-09", status: "open", entries: { claude: { amountCents: null, source: "manual" } } }],
      snapshots: [],
      comparisons: [],
      period: "2026-09",
    });
    expect(view.lines[0].state).toBe("blank");
    expect(view.monthlyCents).toBe(0);
    expect(view.blankLineCount).toBe(1);
  });

  it("uses a closed month's frozen cents instead of a later standing amount", () => {
    const lines = [
      { id: "claude", label: "Claude", category: "ai", project: "tooling", source: "manual", cadence: "monthly", amountCents: 9000, enabled: true, vendor: "", notes: "", freshnessStatus: "manual" },
    ];
    const view = buildView({
      lines,
      periods: [{ id: "2026-08", status: "closed", entries: { claude: { amountCents: 500, source: "manual" } } }],
      snapshots: [],
      comparisons: [],
      period: "2026-08",
    });
    expect(view.monthlyCents).toBe(500);
    expect(view.yearToDateMonths).toBe(1);
  });

  it("replaces the same automatic month entry and keeps a manual override", () => {
    const first = applyAutoEntries(null, "2026-09", [
      { lineId: "aws-s3", amountCents: 100 },
    ], "2026-09-15T15:00:00.000Z");
    const second = applyAutoEntries(first.period, "2026-09", [
      { lineId: "aws-s3", amountCents: 125 },
      { lineId: "cloudflare", amountCents: 40 },
    ], "2026-09-22T15:00:00.000Z");
    expect(second.period.entries["aws-s3"].amountCents).toBe(125);
    expect(Object.keys(second.period.entries)).toEqual(["aws-s3", "cloudflare"]);
    const overridden = applyAutoEntries({
      ...second.period,
      entries: {
        ...second.period.entries,
        "aws-s3": { amountCents: 10, source: "manual", pulledAt: "2026-09-20T00:00:00.000Z" },
      },
    }, "2026-09", [{ lineId: "aws-s3", amountCents: 999 }], "2026-09-22T15:00:00.000Z");
    expect(overridden.period.entries["aws-s3"]).toMatchObject({ amountCents: 10, source: "manual" });
    const closed = applyAutoEntries({ ...second.period, status: "closed" }, "2026-09", [
      { lineId: "aws-s3", amountCents: 1 },
    ], "2026-09-29T15:00:00.000Z");
    expect(closed.skipped).toBe(true);
  });

  it("freezes standing amounts once and quotes csv cells", () => {
    const lines = [
      { id: "domains", label: "Domain, registrations", category: "cloud", project: "hosting", source: "manual", cadence: "monthly", amountCents: 1500, enabled: true, vendor: "", notes: "", freshnessStatus: "manual" },
    ];
    const frozen = freezePeriod(lines, null, "2026-09", "super", "2026-09-30T12:00:00.000Z");
    expect(frozen.period.entries.domains).toMatchObject({ amountCents: 1500, source: "manual" });
    expect(freezePeriod(lines, frozen.period, "2026-09", "super", "2026-10-01T12:00:00.000Z").changed).toBe(false);
    const csv = buildCsv(buildView({
      lines,
      periods: [],
      snapshots: [],
      comparisons: [],
      period: "2026-09",
    }));
    expect(csv).toContain('"Domain, registrations"');
    expect(csv).toContain("Known annual run rate");
    const formula = buildCsv(buildView({
      lines: [{
        id: "cmd",
        label: "=cmd",
        category: "ai",
        project: "tooling",
        source: "manual",
        cadence: "monthly",
        amountCents: -150,
        enabled: true,
        vendor: "",
        notes: "+sum",
        freshnessStatus: "manual",
      }],
      periods: [],
      snapshots: [],
      comparisons: [],
      period: "2026-09",
    }));
    expect(formula).toContain("'=cmd");
    expect(formula).toContain("'+sum");
    expect(formula).toContain("-1.50");
    expect(formula).not.toContain(",=cmd,");
  });

  it("computes hardware only from complete parts", () => {
    expect(hardwareMonthlyCents({
      purchaseCents: 120000, lifeMonths: 12, watts: null, hoursPerMonth: null, centsPerKwh: null, internetShareCents: null,
    })).toBe(10000);
    expect(hardwareMonthlyCents({
      purchaseCents: 120000, lifeMonths: 12, watts: 40, hoursPerMonth: null, centsPerKwh: null, internetShareCents: null,
    })).toBe(null);
    expect(hardwareMonthlyCents({
      purchaseCents: null, lifeMonths: null, watts: null, hoursPerMonth: null, centsPerKwh: null, internetShareCents: 2500,
    })).toBe(2500);
    expect(validateHardwareInput(hardwareInput())).toBeNull();
    expect(validateHardwareInput({ machines: hardwareInput().machines.slice(1) })).toMatch(/each fleet machine/);
    expect(validateHardwareInput(hardwareInput({
      "node-gpu-b": { watts: 200_000, hoursPerMonth: 744, centsPerKwh: 1_000_000 },
    }))).toMatch(/out of range/);
  });
});

describe("cost ledger seed and comparison sources", () => {
  it("leaves every manual amount blank and cites a dated https source", () => {
    expect(SEED_LINES.find((line) => line.id === "claude")).toMatchObject({ source: "manual" });
    expect(SEED_LINES.every((line) => line.autoKey === null || line.source === "auto")).toBe(true);
    for (const row of SEED_COMPARISONS) {
      expect(validateComparisonInput(row)).toBeNull();
      expect(row.sourceReadOn).toBe("2026-09-25");
      expect(row.excludes).toBe("labor");
    }
    expect(SEED_COMPARISONS.find((row) => row.id === "ghost-publisher")).toMatchObject({
      monthlyCents: 2900,
      annualCents: 34800,
      status: "published",
    });
    expect(SEED_COMPARISONS.find((row) => row.id === "newspack").monthlyCents).toBeNull();
    expect(SEED_COMPARISONS.find((row) => row.id === "wordpress-vip")).toMatchObject({
      status: "quote-required",
      monthlyCents: null,
    });
    expect(SEED_COMPARISONS.find((row) => row.id === "arc-xp").monthlyCents).toBeNull();
    expect(SEED_COMPARISONS.find((row) => row.id === "brightspot").monthlyCents).toBeNull();
    expect(SEED_COMPARISONS.find((row) => row.id === "blox").monthlyCents).toBeNull();
    const ghost = SEED_COMPARISONS.find((row) => row.id === "ghost-publisher");
    expect(validateComparisonInput({ ...ghost, sourceReadOn: "2026-02-31" })).toMatch(/Source date/);
    expect(validateComparisonInput({ ...ghost, sourceReadOn: "2026-99-99" })).toMatch(/Source date/);
    expect(validateComparisonInput({ ...ghost, monthlyCents: -1 })).toBe("Monthly amount must be blank or cents.");
    expect(validateComparisonInput({ ...ghost, annualCents: -1 })).toBe("Annual amount must be blank or cents.");
  });
});

describe("cost ledger manual API", () => {
  let db;

  beforeEach(() => {
    db = memoryDb();
  });

  function handler(role, { appCheck = async () => ({}) } = {}) {
    return createCmsCostLedgerHandler({
      firestore: db,
      requirePrincipalFn: async () => user(role),
      verifyAppCheckFn: appCheck,
      now: () => new Date("2026-09-15T15:00:00.000Z"),
      log: { error: vi.fn() },
    });
  }

  it("lets an admin view and refuses an admin edit", async () => {
    const view = response();
    await handler("admin")(request({ action: "view" }), view);
    expect(view.statusCode).toBe(200);
    expect(view.body.canEdit).toBe(false);
    expect(view.body.period).toBe("2026-09");
    expect(await auditRows(db)).toHaveLength(0);
    const edit = response();
    await handler("admin")(request({ action: "seed" }), edit);
    expect(edit.statusCode).toBe(403);
  });

  it("returns the server current month separately from a selected historical period", async () => {
    const view = response();
    await handler("admin")(request({ action: "view", period: "2026-08" }), view);
    expect(view.statusCode).toBe(200);
    expect(view.body.period).toBe("2026-08");
    expect(view.body.currentPeriod).toBe("2026-09");
  });

  it("seeds blank lines once and keeps a saved amount", async () => {
    const seed = response();
    await handler("super_admin")(request({ action: "seed" }), seed);
    expect(seed.statusCode).toBe(200);
    expect(seed.body.created).toContain("claude");
    const seeded = await auditRows(db);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      action: "costLedger.seed",
      actorUid: "user-1",
      actorEmail: "user@example.org",
      source: "203.0.113.17",
      at: "2026-09-15T15:00:00.000Z",
    });
    const saved = response();
    await handler("super_admin")(request({
      action: "saveLine",
      line: {
        id: "claude",
        label: "Claude",
        category: "ai",
        project: "tooling",
        cadence: "monthly",
        amountCents: 2000,
        vendor: "Anthropic",
        notes: "Team plan",
        enabled: true,
      },
    }), saved);
    expect(saved.statusCode).toBe(200);
    const again = response();
    await handler("super_admin")(request({ action: "seed" }), again);
    expect(again.body.created).not.toContain("claude");
    const audits = await auditRows(db);
    expect(audits.filter((row) => row.action === "costLedger.seed")).toHaveLength(1);
    expect(audits.find((row) => row.action === "costLedger.saveLine").after.amountCents).toBe(2000);
    const view = await store.loadView(db, "2026-09");
    expect(view.lines.find((line) => line.id === "claude").monthlyCents).toBe(2000);
    expect(view.csv).toContain("20.00");
    const malformed = response();
    await handler("super_admin")(request({
      action: "saveLine",
      line: { id: "a/b", label: "Broken", category: "ai", project: "tooling", cadence: "monthly", amountCents: null, vendor: "", notes: "", enabled: true },
    }), malformed);
    expect(malformed.statusCode).toBe(400);
    const automatic = response();
    await handler("super_admin")(request({
      action: "saveLine",
      line: {
        id: "aws-s3",
        label: "AWS S3",
        category: "cloud",
        project: "cms",
        cadence: "monthly",
        amountCents: 500,
        vendor: "Amazon Web Services",
        notes: "",
        enabled: true,
      },
    }), automatic);
    expect(automatic.statusCode).toBe(400);
    const stillBlank = await store.loadView(db, "2026-09");
    expect(stillBlank.lines.find((line) => line.id === "aws-s3").standingCents).toBeNull();
  });

  it("creates a missing fleet line from hardware assumptions", async () => {
    const saved = await store.saveHardware(db, hardwareInput({
      "node-compute": { purchaseCents: 120000, lifeMonths: 12 },
    }), { uid: "user-1", email: "user@example.org", source: "test" }, "2026-09-15T15:00:00.000Z");
    expect(saved.after.lines.find((line) => line.id === "hardware-node-compute").amountCents).toBe(10000);
    const view = await store.loadView(db, "2026-09");
    expect(view.lines.find((line) => line.id === "hardware-node-compute").monthlyCents).toBe(10000);
    expect(view.lines.filter((line) => line.id.startsWith("hardware-"))).toHaveLength(5);
    await expect(store.saveHardware(
      db,
      { machines: [] },
      { uid: "user-1", email: null, source: null },
      "2026-09-15T15:00:00.000Z",
    )).rejects.toMatchObject({ status: 400 });
    expect(await auditRows(db)).toHaveLength(1);
  });

  it("rejects amount, cadence, and label changes on a seeded hardware line", async () => {
    const actor = { uid: "user-1", email: "user@example.org", source: "test" };
    const now = "2026-09-15T15:00:00.000Z";
    await store.ensureSeed(db, actor, now);
    const line = {
      id: "hardware-node-compute",
      label: "node-compute",
      category: "hardware",
      project: "hosting",
      cadence: "monthly",
      amountCents: null,
      vendor: "",
      notes: "Amount stays blank until purchase, power, and internet assumptions are entered.",
      enabled: true,
    };
    const fleetRejection = {
      status: 400,
      message: "Hardware amount, cadence and label come from the fleet assumptions.",
    };
    await expect(store.saveLine(db, { ...line, amountCents: 10000 }, actor, now)).rejects.toMatchObject(fleetRejection);
    await expect(store.saveLine(db, { ...line, cadence: "annual" }, actor, now)).rejects.toMatchObject(fleetRejection);
    await expect(store.saveLine(db, { ...line, label: "Office machine" }, actor, now)).rejects.toMatchObject(fleetRejection);
    const saved = await store.saveLine(db, {
      ...line,
      notes: "Paused while the machine is offline.",
      enabled: false,
      vendor: "Local office",
    }, actor, now);
    expect(saved.after.amountCents).toBeNull();
    expect(saved.after.cadence).toBe("monthly");
    expect(saved.after.label).toBe("node-compute");
    expect(saved.after.notes).toBe("Paused while the machine is offline.");
    expect(saved.after.enabled).toBe(false);
    expect(saved.after.vendor).toBe("Local office");
    const view = await store.loadView(db, "2026-09");
    expect(view.lines.find((item) => item.id === "hardware-node-compute")).toMatchObject({
      standingCents: null,
      cadence: "monthly",
      label: "node-compute",
      notes: "Paused while the machine is offline.",
      enabled: false,
      vendor: "Local office",
    });
    await store.saveHardware(db, hardwareInput(), actor, now);
    const afterHardware = await store.loadView(db, "2026-09");
    expect(afterHardware.lines.find((item) => item.id === "hardware-node-compute")).toMatchObject({
      notes: "Paused while the machine is offline.",
      enabled: false,
      vendor: "Local office",
    });
  });

  it("refuses a period edit after close and an editor view", async () => {
    await handler("super_admin")(request({ action: "seed" }), response());
    const closed = response();
    await handler("super_admin")(request({ action: "closeMonth", period: "2026-09" }), closed);
    expect(closed.body.changed).toBe(true);
    const again = response();
    await handler("super_admin")(request({ action: "closeMonth", period: "2026-09" }), again);
    expect(again.body.changed).toBe(false);
    expect((await auditRows(db)).filter((row) => row.action === "costLedger.closeMonth")).toHaveLength(1);
    const edit = response();
    await handler("super_admin")(request({
      action: "savePeriodAmount",
      lineId: "claude",
      period: "2026-09",
      amountCents: 100,
    }), edit);
    expect(edit.statusCode).toBe(409);
    const editor = response();
    await handler("editor")(request({ action: "view" }), editor);
    expect(editor.statusCode).toBe(403);
    const unchecked = response();
    await handler("super_admin", {
      appCheck: async () => {
        throw Object.assign(new Error("Missing App Check token"), { status: 401 });
      },
    })(request({ action: "view" }), unchecked);
    expect(unchecked.statusCode).toBe(401);
    const failedView = response();
    await createCmsCostLedgerHandler({
      firestore: {
        collection() {
          return { get: async () => { throw new Error("firestore down"); } };
        },
      },
      requirePrincipalFn: async () => user("admin"),
      verifyAppCheckFn: async () => ({}),
      now: () => new Date("2026-09-15T15:00:00.000Z"),
      log: { error: vi.fn() },
    })(request({ action: "view" }), failedView);
    expect(failedView.body.error).toBe("The cost ledger could not be loaded.");
  });
});
