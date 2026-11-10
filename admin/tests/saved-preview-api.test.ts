import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/firebase", () => ({ firebaseConfig: { projectId: "demo-njpbs" }, getRequiredAppCheckToken: vi.fn(async () => "app-check") }));
import { cmsRequestSavedPreview, cmsLoadPagePreviewStatus } from "../src/lib/functions";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("saved preview exact API contract", () => {
  it("carries a confirmed save version through the existing request endpoint", async () => {
    const receipt = { success: true, queueId: "abcdefghijklmnopqrst", collection: "cmsPosts", pageId: "story", sourceVersion: 7,
      rendererSha: "a".repeat(40), pagePath: "/posts/story/", previewUrl: null, status: "pending", dispatched: false };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => receipt });
    vi.stubGlobal("fetch", fetchMock);
    // The exact version travels on the existing endpoint, not a parallel API.
    const result = await cmsRequestSavedPreview("token", "cmsPosts", "story", 7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/cmsPreview");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ collection: "cmsPosts", pageId: "story", persistent: false, sourceVersion: 7 });
    expect(result).toEqual(receipt);
  });

  it("keeps addressed polling on the existing status endpoint and preserves receipt fields", async () => {
    const receipt = { success: true, queueId: "abcdefghijklmnopqrst", collection: "cmsPages", pageId: "contact", sourceVersion: 7,
      rendererSha: "b".repeat(40), pagePath: "/contact/", status: "ready", previewUrl: "https://preview.njpbs.org/p/abcdefghijklmnopqrst/" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => receipt });
    vi.stubGlobal("fetch", fetchMock);
    expect(await cmsLoadPagePreviewStatus("token", receipt.queueId)).toEqual(receipt);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ queueId: receipt.queueId });
  });
});

it("opts in to the bounded addressed wait and carries the operation cancellation signal", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "building" }) });
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  await cmsLoadPagePreviewStatus("token", "a".repeat(20), { signal: controller.signal, waitMs: 5000, observedStatus: "pending" });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ queueId: "a".repeat(20), waitMs: 5000, observedStatus: "pending" });
  expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
});
