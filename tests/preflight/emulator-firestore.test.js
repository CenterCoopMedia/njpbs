import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";

const url = "http://127.0.0.1:18080/emulator/v1/projects/demo-njpbs/databases/(default)/documents";
beforeEach(() => { vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:18080"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("resets the explicit fixture project and preserves the successful response", async () => {
  vi.stubGlobal("fetch", async input => Response.json({ path: new URL(input).pathname }));
  const response = await clearEmulatorFirestore(url, { method: "DELETE" }, { projectId: "demo-njpbs-private-fixture" });
  expect(await response.json()).toEqual({ path: "/emulator/v1/projects/demo-njpbs-private-fixture/databases/(default)/documents" });
});

it("fails at a refused reset before a caller can use old fixture data", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
  await expect(clearEmulatorFirestore(url, { method: "DELETE" })).rejects.toThrow("Firestore emulator reset failed (500)");
});

it("checks the response from an explicit reset transport", async () => {
  vi.stubGlobal("fetch", () => { throw new Error("The caller's network spy must not receive fixture resets"); });
  const calls = [];
  const response = new Response(null, { status: 200 });
  const nativeFetch = async (...args) => { calls.push(args); return response; };
  expect(await clearEmulatorFirestore(url, { method: "DELETE" }, undefined, nativeFetch)).toBe(response);
  expect(calls).toEqual([[url, { method: "DELETE" }]]);
  await expect(clearEmulatorFirestore(url, { method: "DELETE" }, undefined,
    async () => new Response(null, { status: 500 }))).rejects.toThrow("Firestore emulator reset failed (500)");
});

it.each([url.replace("127.0.0.1", "example.org"), url.replace("18080", "18081"), url.replace("http:", "https:")])(
  "refuses a reset outside the configured local emulator: %s", async target => {
    await expect(clearEmulatorFirestore(target, { method: "DELETE" })).rejects.toThrow("Only a local Firestore emulator reset is allowed");
  },
);
