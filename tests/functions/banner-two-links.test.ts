import { describe, expect, it, vi } from "vitest";
import contract from "../../functions/lib/cms-settings-contract.js";
import handlers from "../../functions/settings.js";
import { currentCmsSettingsSchemaFor, validateCmsSettingsValues } from "../../packages/content-core/src/cms-settings";

const id = "public-homepage-banner";
const first = { enabled: true, njDecides: true, message: "", linkLabel: "Results", linkHref: "/results/" };
const second = { secondLinkLabel: "Watch live", secondLinkHref: "https://live.njpbs.org/" };
const schema = currentCmsSettingsSchemaFor(id)!;

describe("two-link banner contract at Admin and Functions boundaries", () => {
  it.each([
    [first, null],
    [{ enabled: true, njDecides: true, message: "" }, null],
    [{ ...first, ...second }, null],
    [{ ...first, ...second, secondLinkLabel: "é".repeat(40) }, null],
    [{ ...first, ...second, secondLinkHref: "/" + "x".repeat(2047) }, null],
    [{ ...first, secondLinkLabel: "Watch" }, /must be provided together/],
    [{ ...first, secondLinkHref: "/live/" }, /must be provided together/],
    [{ ...first, ...second, linkLabel: "", linkHref: "" }, /requires the first link/],
    [{ ...first, ...second, secondLinkLabel: "é".repeat(41) }, /at most 80 bytes/],
    [{ ...first, ...second, secondLinkHref: "/" + "x".repeat(2048) }, /at most 2048 bytes/],
    [{ ...first, ...second, secondLinkHref: "javascript:alert(1)" }, /safe link/],
    [{ ...first, ...second, secondLinkHref: "//evil.test/" }, /safe link/],
    [{ ...first, ...second, secondLinkHref: "relative/path" }, /absolute address/],
    [{ ...first, ...second, secondLinkHref: "data:text/html,evil" }, /safe link/],
  ])("checks spec values identically in both runtimes: %j", (values, error) => {
    for (const actual of [validateCmsSettingsValues(schema, values), contract.validateCmsSettingsValues(contract.currentCmsSettingsSchemaFor(id), values)]) {
      if (error) expect(actual).toMatch(error);
      else expect(actual).toBeNull();
    }
  });
  it("preserves all old schemas and rejects new fields on old servers", () => {
    for (const version of [1, 2, 3]) {
      const old = contract.cmsSettingsSchemaFor(id, version);
      const legacy = { enabled: true, message: "Election coverage", linkLabel: "Results", linkHref: "/results/" };
      expect(contract.validateCmsSettingsValues(old, legacy)).toBeNull();
      expect(contract.validateCmsSettingsValues(old, { ...legacy, ...second })).toMatch(/Unknown settings field/);
    }
  });
});

async function save(values: Record<string, unknown>, baseVersion = 7) {
  const stored = { schemaVersion: 4, version: 7, values: { ...first, ...second } };
  const settingsRef = { path: `cmsSettings/${id}` }, userRef = { path: "users/staff" };
  const transaction = { get: vi.fn(async ref => ({ exists: true, data: () => ref === userRef ? { role: "admin", active: true } : stored })), set: vi.fn(), create: vi.fn() };
  const firestore = {
    collection: (name: string) => ({ doc: () => name === "cmsSettings" ? settingsRef : name === "users" ? userRef : { path: `${name}/generated` } }),
    runTransaction: async callback => callback(transaction),
  };
  const handler = handlers.createCmsSaveSettingsHandler({ firestore,
    requirePrincipalFn: async () => ({ uid: "staff", principal: { id: "staff", grants: [{ role: "admin" }] } }),
    prepareMediaUsageWriteFn: async () => ({ ref: { path: "usage/working" }, document: {} }),
    adminLogEntryFn: () => ({}), versionHistoryEntryFn: () => ({}), firestoreDocumentBytesFn: () => 100,
    log: { error: vi.fn() },
  });
  const body = { id, values, baseVersion };
  const req = { method: "POST", body, headers: { "content-type": "application/json" }, rawBody: Buffer.from(JSON.stringify(body)), ip: "192.0.2.1" };
  const res = { headersSent: false, statusCode: 0, body: {} as any, set: vi.fn(), status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; this.headersSent = true; return this; } };
  await handler(req, res);
  return { res, transaction, stored };
}

describe("deployment-window save protection", () => {
  it("refuses an older client's omission of the saved second link even at the current version", async () => {
    const { res, transaction } = await save({ ...first, message: "Changed in old Admin" });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/second link.*Reload/i);
    expect(transaction.set).not.toHaveBeenCalled();
  });
  it("rejects a stale browser tab without altering either link", async () => {
    const { res, transaction } = await save(first, 6);
    expect(res.statusCode).toBe(409);
    expect(transaction.set).not.toHaveBeenCalled();
  });
  it("allows an explicit removal from the new Admin", async () => {
    const { res } = await save({ ...first, secondLinkLabel: "", secondLinkHref: "" });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.values.secondLinkLabel ?? "").toBe("");
    expect(res.body.settings.values.secondLinkHref ?? "").toBe("");
    expect(res.body.settings.values.linkLabel).toBe("Results");
  });
  it("preserves the saved second link on an ordinary edit", async () => {
    const { res } = await save({ ...first, ...second, message: "New election coverage" });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.values).toMatchObject(second);
  });
});
