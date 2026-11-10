import { expect, it, vi } from "vitest";
import { wakePreviewPair } from "./pair-wake";
it("wakes only the retained private binding named by trusted acceptance", async () => {
  const old = { wake: vi.fn() }, next = { wake: vi.fn() };
  const bindings = new Map([["preview-old", old], ["preview-new", next]]);
  await wakePreviewPair({ pairId: "preview-old", rendererSha: "a".repeat(40) }, bindings);
  expect(old.wake).toHaveBeenCalledExactlyOnceWith("a".repeat(40));
  expect(next.wake).not.toHaveBeenCalled();
  await expect(wakePreviewPair({ pairId: "preview-other", rendererSha: "a".repeat(40) }, bindings)).rejects.toThrow("unavailable");
  await expect(wakePreviewPair({ pairId: "https://viewer.test", rendererSha: "a".repeat(40) }, bindings)).rejects.toThrow("Invalid");
});
