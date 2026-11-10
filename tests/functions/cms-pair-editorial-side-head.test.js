import { expect, it, vi } from "vitest";
import { createPairPreviewContextSideWriter } from "../../site/scripts/public-release-pair-preview-context";
it("coalesces queued views to one active and newest pending without dropping the newest completion", async () => {
  const calls = [], resolvers = [];
  const enqueue = createPairPreviewContextSideWriter(input => new Promise(resolve => { calls.push(input); resolvers.push(resolve); }));
  enqueue("first"); await vi.waitFor(() => expect(calls).toEqual(["first"]));
  enqueue("superseded"); enqueue("latest"); expect(calls).toEqual(["first"]);
  resolvers.shift()(); await vi.waitFor(() => expect(calls).toEqual(["first", "latest"])); resolvers.shift()();
  await new Promise(resolve => setImmediate(resolve)); enqueue("after-idle");
  await vi.waitFor(() => expect(calls).toEqual(["first", "latest", "after-idle"])); resolvers.shift()();
});
it.each([14, "storage-unavailable"])("retries transient %s retention without another publication or enqueue", async code => {
  const failed = vi.fn(), write = vi.fn().mockRejectedValueOnce(Object.assign(new Error("private failure"), { code })).mockResolvedValue(undefined);
  const enqueue = createPairPreviewContextSideWriter(write, failed);
  enqueue("selected-current-view");
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(write.mock.calls).toEqual([["selected-current-view"], ["selected-current-view"]]); expect(failed).not.toHaveBeenCalled();
});
it("bounds transient retries and lets the next view continue after exhaustion", async () => {
  let exhausted; const completion = new Promise(resolve => { exhausted = resolve; });
  const failed = vi.fn(() => exhausted()), write = vi.fn().mockRejectedValue(Object.assign(new Error("private failure"), { code: 14 }));
  const enqueue = createPairPreviewContextSideWriter(write, failed); enqueue("unavailable"); await completion;
  expect(write).toHaveBeenCalledTimes(3); expect(failed).toHaveBeenCalledOnce();
  write.mockResolvedValue(undefined); enqueue("next-view");
  await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith("next-view"));
});
it("a newer pending view supersedes retries and permanent failures are diagnosed once", async () => {
  let reject; const failed = vi.fn(), calls = [];
  const enqueue = createPairPreviewContextSideWriter(value => { calls.push(value);
    return value === "old" ? new Promise((_, failure) => { reject = failure; }) : Promise.resolve(); }, failed);
  enqueue("old"); await vi.waitFor(() => expect(calls).toEqual(["old"])); enqueue("new");
  reject(Object.assign(new Error("private unavailable"), { code: 14 }));
  await vi.waitFor(() => expect(calls).toEqual(["old", "new"])); expect(failed).toHaveBeenCalledOnce();
  const invalid = vi.fn().mockRejectedValue(new Error("private invalid source")), diagnostic = vi.fn();
  createPairPreviewContextSideWriter(invalid, diagnostic)("invalid");
  await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledOnce()); expect(invalid).toHaveBeenCalledOnce();
});
