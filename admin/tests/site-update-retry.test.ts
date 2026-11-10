import { expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/functions", () => ({ postFunction: request }));
import { retrySiteUpdate } from "../src/lib/site-update-retry";
import { loadPublishActivitySummary } from "../src/lib/publish-activity";

it("uses the existing authenticated publication request without content changes", async () => {
  const result = { success: true, queueId: "G".repeat(20), status: "pending", message: "Retrying the accepted site update." };
  request.mockResolvedValueOnce(result);
  expect(await retrySiteUpdate("id-token", result.queueId)).toEqual(result);
  expect(request).toHaveBeenLastCalledWith("cmsPublish", "id-token", { aggregateRetryQueueId: result.queueId, retry: true });
});

it("accepts the bounded recovery projection and the older response shape", async () => {
  const contextRetry = { queueId: "G".repeat(20), createdAt: "2026-11-04T12:00:00Z" };
  request.mockResolvedValueOnce({ success: true, activeCount: 0, recoveryCount: 1, contextRetry });
  expect(await loadPublishActivitySummary("id-token", true)).toMatchObject({ contextRetry });
  request.mockResolvedValueOnce({ success: true, activeCount: 0, recoveryCount: 0 });
  expect(await loadPublishActivitySummary("id-token", true)).toMatchObject({ contextRetry: null });
});

it.each([{ queueId: "../foreign", createdAt: null }, { queueId: "G".repeat(20), createdAt: "not-a-time" }])(
  "refuses invalid recovery metadata %j", async contextRetry => {
    request.mockResolvedValueOnce({ success: true, activeCount: 0, recoveryCount: 1, contextRetry });
    await expect(loadPublishActivitySummary("id-token", true)).rejects.toThrow("Publish activity is unavailable.");
  });
