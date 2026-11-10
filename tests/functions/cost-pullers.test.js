import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import pullers from "../../functions/lib/cost-pullers.js";
import store from "../../functions/lib/cost-ledger-store.js";
import { createCostLedgerRefreshRunner, onCostLedgerRefresh } from "../../functions/cost-ledger-refresh.js";

const {
  billingTableName,
  collectPulls,
  costExplorerBody,
  fetchBigQueryTotal,
  fetchCloudflareHistory,
  fetchCostExplorer,
  fetchGithubUsage,
  fetchWithRetry,
  githubUsageUrl,
  numberToCents,
  signAwsRequest,
  parseBigQueryTotal,
  parseCloudflareHistory,
  parseCostExplorer,
  parseGithubUsage,
} = pullers;

// Shape observed from account billing history; identifiers, dates and amounts are synthetic.
const cloudflareHistory = {
  "success": true,
  "result": [
    {
      "id": "fixture-history-1",
      "type": "invoice",
      "occurred_at": "2026-09-02T12:00:00.000Z",
      "amount": 1,
      "amount_to_pay": 0,
      "amount_remaining": 0,
      "ready_to_pay": false,
      "currency": "usd",
      "invoice_id": "fixture-invoice-1",
      "receipt_id": "fixture-receipt-1",
      "status": "CLOSED",
      "source": "stripe"
    }
  ],
  "result_info": {
    "page": 1,
    "per_page": 50,
    "next_page": false
  }
};

const NOW = new Date("2026-09-15T15:00:00.000Z");
let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(() => {
    throw new Error("Tests must provide a fixture fetch implementation.");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/cost-pullers/${name}`, import.meta.url), "utf8"));
}

function cloneStored(value) {
  if (Array.isArray(value)) return value.map((item) => cloneStored(item));
  if (!value || typeof value !== "object") return value;
  if (value.constructor && value.constructor.name !== "Object") return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = cloneStored(item);
  return copy;
}

function memoryDb(initial = []) {
  const docs = new Map(initial.map(([path, value]) => [path, cloneStored(value)]));
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
        async get(ref) { return ref.get(); },
        set(ref, data) { return ref.set(data); },
      });
    },
    dump: docs,
  };
  return database;
}

describe("billing response parsers", () => {
  it("sums fractional charges and credits exactly before rounding each ledger line", () => {
    const data = fixture("fractional-usage.json");
    expect(parseCostExplorer(data.aws)).toEqual([
      { lineId: "aws-s3", amountCents: 1 },
      { lineId: "aws-lightsail", amountCents: -1 },
      { lineId: "aws-other", amountCents: 1 },
    ]);
    expect(parseGithubUsage(data.github)).toEqual([
      { lineId: "github-actions", amountCents: 1 },
      { lineId: "github-other", amountCents: -1 },
    ]);
    expect(() => parseGithubUsage({ usageItems: [{ netAmount: "invalid" }] })).toThrow(/dollar value/);
    expect(() => parseGithubUsage({ usageItems: [{ netAmount: "99999999999999999999" }] })).toThrow(/out of range/);
    expect(parseGithubUsage({ usageItems: [{ product: "actions", netAmount: 1e-7 }] })[0].amountCents).toBe(0);
  });

  it("reads a BigQuery total and a zero export", () => {
    expect(parseBigQueryTotal(fixture("gcp-query-response.json"))).toEqual([{ lineId: "gcp-cloud", amountCents: 1234 }]);
    expect(parseBigQueryTotal({ totalRows: "0" })).toEqual([
      { lineId: "gcp-cloud", amountCents: 0 },
    ]);
    expect(billingTableName("njpbs-site.billing.gcp_billing_export_v1")).toBe(
      "`njpbs-site.billing.gcp_billing_export_v1`",
    );
    expect(() => billingTableName("bad table")).toThrow(/not configured/);
  });

  const invoice = cloudflareHistory.result[0];

  it("sums Cloudflare history for the New York month and rejects another currency", () => {
    expect(parseCloudflareHistory({
      success: true,
      result: [
        { ...invoice, amount: 20.99, currency: "USD", occurred_at: "2026-09-15T15:00:00.000Z" },
        { ...invoice, amount: 1, occurred_at: "2026-08-31T12:00:00.000Z" },
      ],
    }, "2026-09")).toEqual([{ lineId: "cloudflare", amountCents: 2099 }]);
    expect(() => parseCloudflareHistory({
      success: true,
      result: [{ ...invoice, currency: "EUR" }],
    }, "2026-09")).toThrow(/non-USD/);
    expect(() => parseCloudflareHistory({
      success: true,
      result: [{ ...invoice, type: "credit", currency: "eur" }],
    }, "2026-09")).toThrow(/non-USD/);
    expect(() => parseCloudflareHistory({
      success: true,
      result: [{ ...invoice, occurred_at: "not-a-date" }],
    }, "2026-09")).toThrow(/date is invalid/);
    expect(() => parseCloudflareHistory({
      success: true,
      result: [{ ...invoice, currency: undefined }],
    }, "2026-09")).toThrow(/non-USD/);
  });

  it.each(["usd", "USD", "uSd"])("accepts %s and both integer and fractional invoice amounts", (currency) => {
    expect(parseCloudflareHistory({ success: true, result: [
      { ...invoice, amount: 20.99, currency }, { ...invoice, amount: 1, currency },
    ] }, "2026-09")).toEqual([{ lineId: "cloudflare", amountCents: 2199 }]);
  });

  it("counts only closed invoices, excluding credits, refunds and unsuccessful payments", () => {
    expect(parseCloudflareHistory({ success: true, result: [
      { ...invoice, amount: 20.99 },
      { ...invoice, type: "credit", status: "CREDIT_FULLY_APPLIED", amount: 5 },
      { ...invoice, type: "refund", amount: 5 },
      { ...invoice, type: "payment", status: "FAILED", amount: 5 },
    ] }, "2026-09")).toEqual([{ lineId: "cloudflare", amountCents: 2099 }]);
  });

  it.each([
    { type: undefined }, { type: "unknown" }, { type: "Invoice" },
    { status: undefined }, { status: "unknown" }, { status: "closed" },
    { status: "OPEN" }, { status: "FAILED" },
  ])("rejects non-closed or unrecognized invoice types or statuses: %j", (fields) => {
    expect(() => parseCloudflareHistory({ success: true, result: [{ ...invoice, ...fields }] }, "2026-09"))
      .toThrow(/not recognized/);
  });

  it("rejects missing invoice amounts even when remaining balances are zero", () => {
    const { amount, ...withoutAmount } = invoice;
    for (const balances of [
      {}, { amount_to_pay: 5 }, { amount_remaining: 5 },
      { amount_to_pay: undefined }, { amount_remaining: undefined },
    ]) {
      expect(() => parseCloudflareHistory({ success: true, result: [{ ...withoutAmount, ...balances }] }, "2026-09"))
        .toThrow(/amount is missing/);
    }
    expect(() => parseCloudflareHistory({ success: true, result: [{ ...invoice, amount: "1" }] }, "2026-09"))
      .toThrow(/amount is missing/);
    expect(parseCloudflareHistory({ success: true, result: [{ ...invoice, amount: 0 }] }, "2026-09"))
      .toEqual([{ lineId: "cloudflare", amountCents: 0 }]);
    expect(parseCloudflareHistory({ success: true, result: [
      { ...withoutAmount, amount_to_pay: 5, occurred_at: "2026-03-01T12:00:00Z" },
    ] }, "2026-09")).toEqual([{ lineId: "cloudflare", amountCents: 0 }]);
  });

  it("reads the checked-in BigQuery response fixture through the bounded request path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fixture("gcp-query-response.json"),
    });
    const result = await fetchBigQueryTotal("2026-09", {
      COST_LEDGER_GCP_BILLING_TABLE: "njpbs-site.billing.gcp_billing_export_v1",
      COST_LEDGER_GCP_PROJECT: "njpbs-site",
      COST_LEDGER_GCP_BILLING_SA: "{}",
    }, fetchImpl, { getAccessToken: async () => "fixture-token" });
    expect(parseBigQueryTotal(result)).toEqual([{ lineId: "gcp-cloud", amountCents: 1234 }]);
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.timeoutMs).toBeGreaterThan(0);
    expect(request.timeoutMs).toBeLessThanOrEqual(8_000);
    expect(request.query).toContain("currency != 'USD'");
    expect(request.maximumBytesBilled).toBe("1073741824");
  });

  it("uses one BigQuery query attempt when the provider returns a retryable failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchBigQueryTotal("2026-09", {
      COST_LEDGER_GCP_BILLING_TABLE: "njpbs-site.billing.gcp_billing_export_v1",
      COST_LEDGER_GCP_PROJECT: "njpbs-site",
      COST_LEDGER_GCP_BILLING_SA: "{}",
    }, fetchImpl, { getAccessToken: async () => "fixture-token" })).rejects.toThrow(/request failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an error without entries when the selected BigQuery month has no rows", async () => {
    // #3784: an aggregate still returns one result row while the month backfills.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobComplete: true,
        totalRows: "1",
        rows: [{ f: [{ v: "0" }, { v: "0" }] }],
      }),
    });
    const results = await collectPulls({
      flags: { COST_LEDGER_GCP_PULL: true },
      env: {
        COST_LEDGER_GCP_BILLING_TABLE: "njpbs-site.billing.gcp_billing_export_v1",
        COST_LEDGER_GCP_PROJECT: "njpbs-site",
        COST_LEDGER_GCP_BILLING_SA: "{}",
      },
      clients: { gcp: (period, env) => fetchBigQueryTotal(period, env, fetchImpl, {
        getAccessToken: async () => "fixture-token",
      }) },
      period: "2026-10",
    });
    expect(results.find(({ id }) => id === "gcp")).toMatchObject({
      status: "error", entries: [],
    });
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.query).toContain("COUNT(*) AS row_count");
    expect(request.query).toContain("WHERE invoice.month = '202610'");
  });

  it("signs the published AWS Signature Version 4 example", () => {
    expect(numberToCents(10)).toBe(1000);
    expect(numberToCents(20.99)).toBe(2099);
    const signed = signAwsRequest({
      method: "GET",
      host: "example.amazonaws.com",
      headers: {},
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "service",
      amzDate: "20150830T123600Z",
    });
    expect(signed.authorization).toContain(
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("groups Cost Explorer services without dropping the remainder", () => {
    expect(costExplorerBody("2026-09")).toContain('"End":"2026-10-01"');
    expect(parseCostExplorer(fixture("aws-cost-explorer.json"))).toEqual([
      { lineId: "aws-s3", amountCents: 125 },
      { lineId: "aws-lightsail", amountCents: 350 },
      { lineId: "aws-other", amountCents: 10 },
    ]);
  });

  it.each([{}, { COST_LEDGER_GITHUB_ACCOUNT: "CenterCoopMedia" },
    { COST_LEDGER_GITHUB_ACCOUNT: "CenterCoopMedia", COST_LEDGER_GITHUB_ACCOUNT_TYPE: "other" }])(
    "rejects incomplete GitHub billing identity before transport: %j", async (configuration) => {
      const client = vi.fn();
      const env = { COST_LEDGER_GITHUB_TOKEN: "fixture-token", ...configuration };
      const results = await collectPulls({ flags: { COST_LEDGER_GITHUB_PULL: true }, env,
        clients: { github: client }, period: "2026-10" });
      expect(results.find((result) => result.id === "github").status).toBe("error");
      expect(client).not.toHaveBeenCalled();
      await expect(fetchGithubUsage("2026-10", env, client)).rejects.toThrow(/not configured/);
      expect(client).not.toHaveBeenCalled();
    },
  );

  it("splits GitHub Actions from other products", () => {
    expect(githubUsageUrl({ COST_LEDGER_GITHUB_ACCOUNT: "fixture-user", COST_LEDGER_GITHUB_ACCOUNT_TYPE: "user" }, "2026-09")).toBe(
      "https://api.github.com/users/fixture-user/settings/billing/usage?year=2026&month=9",
    );
    expect(parseGithubUsage(fixture("github-usage.json"))).toEqual([
      { lineId: "github-actions", amountCents: 250 },
      { lineId: "github-other", amountCents: 1000 },
    ]);
  });
});

describe("weekly cost refresh", () => {
  it("does not call a client while its flag is off", async () => {
    const clients = {
      gcp: vi.fn(),
      cloudflare: vi.fn(),
      aws: vi.fn(),
      github: vi.fn(),
    };
    const results = await collectPulls({
      flags: { COST_LEDGER_GCP_PULL: "false" },
      env: { COST_LEDGER_GCP_BILLING_SA: "present", COST_LEDGER_GCP_BILLING_TABLE: "a.b.c", COST_LEDGER_GCP_PROJECT: "njpbs-site" },
      clients,
      period: "2026-09",
    });
    expect(results.find((result) => result.id === "gcp").status).toBe("disabled");
    expect(clients.gcp).not.toHaveBeenCalled();
  });

  it("records a missing credential for every enabled source without a network call", async () => {
    const clients = { gcp: vi.fn(), cloudflare: vi.fn(), aws: vi.fn(), github: vi.fn() };
    const results = await collectPulls({
      flags: {
        COST_LEDGER_GCP_PULL: "true",
        COST_LEDGER_CLOUDFLARE_PULL: "true",
        COST_LEDGER_AWS_PULL: "true",
        COST_LEDGER_GITHUB_PULL: "true",
      },
      env: {},
      clients,
      period: "2026-09",
    });
    for (const result of results) {
      expect(result).toMatchObject({ status: "error", message: "Credential is not configured." });
      expect(clients[result.id]).not.toHaveBeenCalled();
    }
  });

  it("upserts the same month from a fixture and keeps a manual override", async () => {
    const db = memoryDb([
      ["costLedgerLines/aws-s3", { label: "AWS S3", category: "cloud", project: "cms", source: "auto", currency: "USD", cadence: "monthly", amountCents: null, vendor: "Amazon Web Services", notes: "", enabled: true, autoKey: "aws-s3", freshnessStatus: "disabled", freshnessAt: null, updatedAt: NOW.toISOString(), updatedBy: "seed" }],
      ["costLedgerLines/aws-lightsail", { label: "Lightsail", category: "cloud", project: "spotlight", source: "auto", currency: "USD", cadence: "monthly", amountCents: null, vendor: "Amazon Web Services", notes: "", enabled: true, autoKey: "aws-lightsail", freshnessStatus: "disabled", freshnessAt: null, updatedAt: NOW.toISOString(), updatedBy: "seed" }],
      ["costLedgerLines/aws-other", { label: "AWS other", category: "cloud", project: "hosting", source: "auto", currency: "USD", cadence: "monthly", amountCents: null, vendor: "Amazon Web Services", notes: "", enabled: true, autoKey: "aws-other", freshnessStatus: "disabled", freshnessAt: null, updatedAt: NOW.toISOString(), updatedBy: "seed" }],
      ["costLedgerPeriods/2026-08", { period: "2026-08", status: "open", currency: "USD", entries: {}, closedAt: null, closedBy: null, updatedAt: NOW.toISOString() }],
      ["costLedgerPeriods/2026-09", { period: "2026-09", status: "open", currency: "USD", entries: { "aws-s3": { amountCents: 10, source: "manual", pulledAt: NOW.toISOString() } }, closedAt: null, closedBy: null, updatedAt: NOW.toISOString() }],
    ]);
    const aws = vi.fn(async () => fixture("aws-cost-explorer.json"));
    const run = createCostLedgerRefreshRunner({
      firestore: db,
      now: () => NOW,
      flags: { COST_LEDGER_AWS_PULL: "true" },
      env: { COST_LEDGER_AWS_ACCESS_KEY_ID: "test-key", COST_LEDGER_AWS_SECRET_ACCESS_KEY: "test-secret" },
      clients: { gcp: vi.fn(), cloudflare: vi.fn(), aws, github: vi.fn() },
      log: { info: vi.fn() },
    });
    await run();
    await run();
    expect(aws).toHaveBeenCalledTimes(3);
    const september = db.dump.get("costLedgerPeriods/2026-09");
    expect(september.entries["aws-s3"]).toMatchObject({ amountCents: 10, source: "manual" });
    expect(september.entries["aws-lightsail"].amountCents).toBe(350);
    expect(september.entries["aws-other"].amountCents).toBe(10);
    expect(db.dump.get("costLedgerPeriods/2026-08").status).toBe("closed");
    expect(db.dump.get("costLedgerPeriods/2026-08").entries["aws-lightsail"].amountCents).toBe(350);
    expect(db.dump.get("costLedgerSnapshots/2026-09-15").monthlyCents).toBe(370);
    expect(db.dump.get("costLedgerLines/aws-lightsail").freshnessStatus).toBe("fresh");
  });

  it("is a complete no-op while every source is disabled", async () => {
    const db = { collection: vi.fn(), runTransaction: vi.fn() };
    const now = vi.fn(() => NOW);
    const clients = { gcp: vi.fn(), cloudflare: vi.fn(), aws: vi.fn(), github: vi.fn() };
    const log = { info: vi.fn() };
    const run = createCostLedgerRefreshRunner({
      firestore: db,
      now,
      flags: {},
      env: {},
      clients,
      log,
    });
    const result = await run();
    expect(result).toEqual({ outcome: "disabled", results: [] });
    expect(now).not.toHaveBeenCalled();
    expect(db.collection).not.toHaveBeenCalled();
    for (const client of Object.values(clients)) expect(client).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("continues AWS Cost Explorer pagination with checked-in responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => fixture("aws-cost-explorer-page-1.json") })
      .mockResolvedValueOnce({ ok: true, json: async () => fixture("aws-cost-explorer-page-2.json") });
    const result = await fetchCostExplorer("2026-09", {
      COST_LEDGER_AWS_ACCESS_KEY_ID: "fixture-access-key",
      COST_LEDGER_AWS_SECRET_ACCESS_KEY: "fixture-secret",
    }, fetchImpl, NOW);
    expect(result.ResultsByTime).toHaveLength(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).NextPageToken).toBe("fixture-next");
  });

  it("does not retry a GitHub transport timeout", async () => {
    const timeout = Object.assign(new Error("fixture timeout"), { name: "TimeoutError" });
    const fetchImpl = vi.fn(async () => { throw timeout; });
    await expect(fetchGithubUsage("2026-09", {
      COST_LEDGER_GITHUB_TOKEN: "fixture-token",
      COST_LEDGER_GITHUB_ACCOUNT: "CenterCoopMedia", COST_LEDGER_GITHUB_ACCOUNT_TYPE: "org",
    }, fetchImpl)).rejects.toThrow(/request failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps retryable requests at the configured attempt count", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchWithRetry(fetchImpl, "https://fixture.invalid", {}, "Fixture", {
      attempts: 3,
      timeoutMs: 1,
      budget: { remaining: () => 1 },
    })).rejects.toThrow(/request failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never changes manual or hardware lines through automatic writes or freshness", async () => {
    const db = memoryDb([
      ["costLedgerLines/aws-s3", { source: "manual", autoKey: "aws-s3", category: "cloud", freshnessStatus: "manual", freshnessAt: null }],
      ["costLedgerLines/hardware-node-gpu-b", { source: "auto", autoKey: "hardware-node-gpu-b", category: "hardware", freshnessStatus: "manual", freshnessAt: null }],
    ]);
    const applied = await store.writeAutomaticPeriod(db, "2026-09", [
      { lineId: "aws-s3", amountCents: 99 },
      { lineId: "hardware-node-gpu-b", amountCents: 99 },
    ], NOW.toISOString());
    await store.writeLineFreshness(db, "aws-s3", "fresh", NOW.toISOString());
    await store.writeLineFreshness(db, "hardware-node-gpu-b", "fresh", NOW.toISOString());
    expect(applied.skipped).toBe(true);
    expect(db.dump.has("costLedgerPeriods/2026-09")).toBe(false);
    expect(db.dump.get("costLedgerLines/aws-s3").freshnessStatus).toBe("manual");
    expect(db.dump.get("costLedgerLines/hardware-node-gpu-b").freshnessStatus).toBe("manual");
  });

  it("does not include a client error in the scheduler result", async () => {
    const clients = { gcp: vi.fn(async () => { throw new Error("token=never-log-this"); }), cloudflare: vi.fn(), aws: vi.fn(), github: vi.fn() };
    const results = await collectPulls({
      flags: { COST_LEDGER_GCP_PULL: "true" },
      env: { COST_LEDGER_GCP_BILLING_SA: "fixture", COST_LEDGER_GCP_BILLING_TABLE: "a.b.c", COST_LEDGER_GCP_PROJECT: "njpbs-site" },
      clients,
      period: "2026-09",
    });
    expect(results.find((result) => result.id === "gcp")).toMatchObject({ status: "error", message: "Pull failed." });
  });

  it("refreshes an open prior month but waits until day eight to close it", async () => {
    const early = new Date("2026-09-01T15:00:00.000Z");
    const db = memoryDb([
      ["costLedgerLines/aws-s3", { source: "auto", autoKey: "aws-s3", category: "cloud", freshnessStatus: "disabled", freshnessAt: null }],
      ["costLedgerPeriods/2026-08", { period: "2026-08", status: "open", entries: {}, closedAt: null, closedBy: null }],
    ]);
    const aws = vi.fn(async () => fixture("aws-cost-explorer.json"));
    await createCostLedgerRefreshRunner({
      firestore: db,
      now: () => early,
      flags: { COST_LEDGER_AWS_PULL: "true" },
      env: { COST_LEDGER_AWS_ACCESS_KEY_ID: "test-key", COST_LEDGER_AWS_SECRET_ACCESS_KEY: "test-secret" },
      clients: { gcp: vi.fn(), cloudflare: vi.fn(), aws, github: vi.fn() },
      log: { info: vi.fn() },
    })();
    const august = db.dump.get("costLedgerPeriods/2026-08");
    expect(august.status).toBe("open");
    expect(august.entries["aws-s3"].amountCents).toBe(125);
  });

  it("does not reclose a month that a super admin reopened", async () => {
    const db = memoryDb([
      ["costLedgerLines/aws-s3", { source: "auto", autoKey: "aws-s3", category: "cloud", freshnessStatus: "disabled", freshnessAt: null }],
      ["costLedgerPeriods/2026-08", { period: "2026-08", status: "closed", entries: {}, closedAt: NOW.toISOString(), closedBy: "admin" }],
    ]);
    await store.reopenMonth(db, "2026-08", { uid: "super-admin", email: null, source: "test" }, NOW.toISOString());
    const aws = vi.fn(async () => fixture("aws-cost-explorer.json"));
    await createCostLedgerRefreshRunner({
      firestore: db,
      now: () => NOW,
      flags: { COST_LEDGER_AWS_PULL: "true" },
      env: { COST_LEDGER_AWS_ACCESS_KEY_ID: "test-key", COST_LEDGER_AWS_SECRET_ACCESS_KEY: "test-secret" },
      clients: { gcp: vi.fn(), cloudflare: vi.fn(), aws, github: vi.fn() },
      log: { info: vi.fn() },
    })();
    const august = db.dump.get("costLedgerPeriods/2026-08");
    expect(august.status).toBe("open");
    expect(august.schedulerCloseBlockedAt).toBe(NOW.toISOString());
  });

  it("leaves a prior month open when its enabled source fails", async () => {
    const db = memoryDb([
      ["costLedgerLines/aws-s3", { source: "auto", autoKey: "aws-s3", category: "cloud", freshnessStatus: "disabled", freshnessAt: null }],
      ["costLedgerPeriods/2026-08", { period: "2026-08", status: "open", entries: {}, closedAt: null, closedBy: null }],
    ]);
    const aws = vi.fn(async (period) => {
      if (period === "2026-08") throw new Error("fixture pull failure");
      return fixture("aws-cost-explorer.json");
    });
    await createCostLedgerRefreshRunner({
      firestore: db,
      now: () => NOW,
      flags: { COST_LEDGER_AWS_PULL: "true" },
      env: { COST_LEDGER_AWS_ACCESS_KEY_ID: "test-key", COST_LEDGER_AWS_SECRET_ACCESS_KEY: "test-secret" },
      clients: { gcp: vi.fn(), cloudflare: vi.fn(), aws, github: vi.fn() },
      log: { info: vi.fn() },
    })();
    expect(db.dump.get("costLedgerPeriods/2026-08").status).toBe("open");
  });

  it("checks the scheduler close block inside the closing transaction", async () => {
    const db = memoryDb([
      ["costLedgerLines/aws-s3", { source: "auto", autoKey: "aws-s3", category: "cloud", enabled: true, amountCents: null }],
      ["costLedgerPeriods/2026-08", { period: "2026-08", status: "open", entries: {}, schedulerCloseBlockedAt: NOW.toISOString() }],
    ]);
    const result = await store.closeMonth(
      db,
      "2026-08",
      { uid: "cost-ledger-refresh", email: null, source: "scheduler" },
      NOW.toISOString(),
      { onlyIfExists: true, respectSchedulerBlock: true },
    );
    expect(result.changed).toBe(false);
    expect(db.dump.get("costLedgerPeriods/2026-08").status).toBe("open");
  });

  it("pages Cloudflare history and schedules one Monday run", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...cloudflareHistory,
          result_info: { ...cloudflareHistory.result_info, next_page: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...cloudflareHistory,
          result: [{ ...cloudflareHistory.result[0], amount: 2.99 }],
          result_info: { ...cloudflareHistory.result_info, page: 2 },
        }),
      });
    const body = await fetchCloudflareHistory("2026-09", {
      COST_LEDGER_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      COST_LEDGER_CLOUDFLARE_API_TOKEN: "test-token",
    }, fetchImpl);
    expect(body.result).toHaveLength(2);
    expect(parseCloudflareHistory(body, "2026-09")).toEqual([{ lineId: "cloudflare", amountCents: 399 }]);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
    expect(onCostLedgerRefresh.__endpoint).toMatchObject({
      scheduleTrigger: { schedule: "0 8 * * 1" },
      concurrency: 1,
      maxInstances: 1,
    });
  });
});

describe("Cloudflare billing pages", () => {
  const env = { COST_LEDGER_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    COST_LEDGER_CLOUDFLARE_API_TOKEN: "fixture-token" };
  const response = (result_info) => ({ ok: true, json: async () => ({
    success: true, result: [], ...(result_info === undefined ? {} : { result_info }),
  }) });

  it("stops on the real next_page false response without total_count", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => cloudflareHistory }));
    expect(parseCloudflareHistory(await fetchCloudflareHistory("2026-10", env, fetchImpl), "2026-10"))
      .toEqual([{ lineId: "cloudflare", amountCents: 0 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("continues while next_page is true and stops when false", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ page: 1, per_page: 50, next_page: true }))
      .mockResolvedValueOnce(response({ page: 2, per_page: 50, next_page: false }));
    await fetchCloudflareHistory("2026-09", env, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("page")).toBe("2");
  });

  it("still supports total_count pagination", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ page: 1, per_page: 50, total_count: 51 }))
      .mockResolvedValueOnce(response({ page: 2, per_page: 50, total_count: 51 }));
    await fetchCloudflareHistory("2026-09", env, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { page: 1, per_page: 50 }, { next_page: "false" }])(
    "rejects missing pagination signals: %j", async (info) => {
      const fetchImpl = vi.fn(async () => response(info));
      await expect(fetchCloudflareHistory("2026-09", env, fetchImpl)).rejects.toThrow(/whether more pages exist/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ next_page: true }, { total_count: 1001, per_page: 50 }])(
    "rejects history beyond the twenty-page cap: %j", async (info) => {
      const fetchImpl = vi.fn(async () => response(info));
      await expect(fetchCloudflareHistory("2026-09", env, fetchImpl)).rejects.toThrow(/20 pages/);
      expect(fetchImpl).toHaveBeenCalledTimes(20);
    },
  );
});

describe("GitHub billing pages", () => {
  const env = { COST_LEDGER_GITHUB_TOKEN: "fixture-token",
    COST_LEDGER_GITHUB_ACCOUNT: "CenterCoopMedia", COST_LEDGER_GITHUB_ACCOUNT_TYPE: "org" };
  const nextUrl = (page) => `${githubUsageUrl(env, "2026-09")}&page=${page}&per_page=1`;
  const response = (body, next) => ({ ok: true, json: async () => body,
    headers: new Headers(next ? { link: `<${next}>; rel="next"` } : {}) });

  it("combines every page before rounding and stops without a Link header", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ usageItems: [{ product: "actions", netAmount: "0.004" }] }, nextUrl(2)))
      .mockResolvedValueOnce(response({ usageItems: [{ product: "actions", netAmount: "0.004" }, { product: "other", netAmount: "1" }] }));
    expect(parseGithubUsage(await fetchGithubUsage("2026-09", env, fetchImpl))).toEqual([
      { lineId: "github-actions", amountCents: 1 }, { lineId: "github-other", amountCents: 100 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("per_page")).toBe("1");
  });

  it("rejects a next page beyond the cap", async () => {
    let page = 1;
    const fetchImpl = vi.fn(async () => response({ usageItems: [] }, nextUrl(++page)));
    await expect(fetchGithubUsage("2026-09", env, fetchImpl)).rejects.toThrow(/20 pages/);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it("rejects a repeated next link", async () => {
    const fetchImpl = vi.fn(async () => response({ usageItems: [] }, nextUrl(2)));
    await expect(fetchGithubUsage("2026-09", env, fetchImpl)).rejects.toThrow(/repeated/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    "https://evil.invalid/usage?year=2026&month=9",
    nextUrl(2).replace("month=9", "month=8"),
    nextUrl(2).replace("/organizations/CenterCoopMedia/", "/organizations/other/"),
  ])("rejects an out-of-scope next link before sending credentials: %s", async (next) => {
    const fetchImpl = vi.fn(async () => response({ usageItems: [] }, next));
    await expect(fetchGithubUsage("2026-09", env, fetchImpl)).rejects.toThrow(/outside/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("automatic close completeness", () => {
  it.each(["missing", "skipped", "manual override", "estimated", "final"])("handles %s prior-month amounts", async (mode) => {
    const ids = ["aws-s3", "aws-lightsail", "aws-other"];
    const db = memoryDb([
      ...ids.filter((id) => mode !== "skipped" && (mode !== "missing" || id !== "aws-other")).map((id) => [
        `costLedgerLines/${id}`, { label: id, source: "auto", autoKey: id, category: "cloud", enabled: true, freshnessStatus: "disabled" },
      ]),
      ["costLedgerPeriods/2026-08", { period: "2026-08", status: "open", entries:
        mode === "manual override" ? { "aws-other": { source: "manual", amountCents: 999 } } : {} }],
    ]);
    const statuses = [];
    const ledger = { ...store, writeLineFreshness: async (...args) => {
      statuses.push({ line: args[1], status: args[2] });
      return store.writeLineFreshness(...args);
    } };
    const aws = async () => {
      const body = fixture("aws-cost-explorer.json");
      body.ResultsByTime[0].Estimated = mode === "estimated";
      return body;
    };
    const result = await createCostLedgerRefreshRunner({ firestore: db, ledger, now: () => NOW,
      flags: { COST_LEDGER_AWS_PULL: true },
      env: { COST_LEDGER_AWS_ACCESS_KEY_ID: "fixture", COST_LEDGER_AWS_SECRET_ACCESS_KEY: "fixture" },
      clients: { aws }, log: { info: vi.fn() },
    })();
    expect(db.dump.get("costLedgerPeriods/2026-08").status).toBe(mode === "estimated" ? "open" : "closed");
    if (mode !== "skipped") expect(db.dump.get("costLedgerPeriods/2026-09").entries["aws-s3"].amountCents).toBe(125);
    if (mode === "missing" || mode === "skipped") {
      expect(statuses.some(({ line, status }) => line === "aws-other" && status === "fresh")).toBe(false);
      expect(result.results.find(({ id }) => id === "aws").status).toBe("fresh");
    }
    if (mode === "manual override") expect(statuses.find(({ line }) => line === "aws-other").status).toBe("manual");
    if (mode === "estimated") expect(result.results.find(({ id }) => id === "aws").entries.every((entry) => entry.estimated)).toBe(true);
  });
});
