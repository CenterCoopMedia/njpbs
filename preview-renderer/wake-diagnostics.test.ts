import { afterEach, expect, it, vi } from "vitest";
import { wakeDiagnostics } from "./wake-diagnostics";
const env = { PREVIEW_RENDERER_SHA: "a".repeat(40), PREVIEW_SERIALIZER_ID: "preview-next" };
const requestId = "11111111-1111-4111-8111-111111111111";
afterEach(() => vi.restoreAllMocks());
it("joins the addressed wake to the actual process without serializing health or provider data", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = { startup: { startupId: requestId, processStartedAtMs: 1_790_000_000_000 }, private: "private-body" };
  const measure = wakeDiagnostics(env, requestId);
  expect(await measure("container-request", async () => result)).toBe(result);
  const rows = log.mock.calls.map(([line]) => JSON.parse(line));
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ requestId, ...envFields(), ...result.startup, outcome: "ok",
    stage: "container-request", durationMs: expect.any(Number), atMs: expect.any(Number) });
  expect(JSON.stringify(rows)).not.toContain("private-body");
});
it("retains failures and continues work with an unavailable log sink", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const measure = wakeDiagnostics(env, requestId), error = new Error("private-provider-error");
  await expect(measure("pending-work", async () => { throw error; })).rejects.toBe(error);
  expect(JSON.parse(log.mock.calls[1][0])).toMatchObject({ outcome: "error", stage: "pending-work" });
  expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
  log.mockImplementation(() => { throw new Error("sink unavailable"); });
  expect(await measure("pending-work", async () => true)).toBe(true);
});
function envFields() { return { rendererSha: env.PREVIEW_RENDERER_SHA, serializerId: env.PREVIEW_SERIALIZER_ID }; }
