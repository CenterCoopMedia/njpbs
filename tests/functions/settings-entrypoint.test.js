import { createRequire } from "node:module";
import Module from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const settingsPath = require.resolve("../../functions/settings.js");
const previous = require.cache[settingsPath];
const originalLoad = Module._load;
const runTransaction = vi.fn(async () => ({ changed: false, settings: {} }));
let settings;
try {
  // Exercise the deployed endpoint's real option wiring. Only the HTTP host,
  // authentication and database are replaced; no emulator or network is used.
  Module._load = function load(request, parent, isMain) {
    if (parent?.filename === settingsPath) {
      if (request === "./lib/cms-edge") return { cmsOnRequest: (_options, handler) => handler };
      if (request === "./lib/auth") return { requirePrincipal: async () => ({
        uid: "fixture-admin", principal: { id: "fixture-admin", grants: [{ role: "admin" }] },
      }) };
      if (request === "./lib/firebase") return { db: { runTransaction } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[settingsPath];
  settings = require(settingsPath);
} finally {
  Module._load = originalLoad;
  if (previous) require.cache[settingsPath] = previous;
  else delete require.cache[settingsPath];
}
afterAll(() => vi.restoreAllMocks());

async function publish(id, transport = "public-context-no-build-v1") {
  const body = { id, baseVersion: 1, ...(transport ? { publicationTransport: transport } : {}) };
  const response = { code: 200, set() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
  await settings.cmsPublishSettings({ method: "POST", body,
    rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, response);
  return response;
}

describe("deployed settings Publish entrypoint", () => {
  it.each(["public-homepage-banner", "public-site-chrome", "site-navigation", "nj-decides-brand"])(
    "admits %s to the transaction with the atomic transport", async id => {
      runTransaction.mockClear();
      expect((await publish(id)).code).toBe(200);
      expect(runTransaction).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps private settings and outdated election clients out of the transaction", async () => {
    runTransaction.mockClear();
    expect((await publish("newsroom-home")).code).toBe(400);
    expect((await publish("nj-decides-brand", null)).code).toBe(409);
    expect(runTransaction).not.toHaveBeenCalled();
  });
});
