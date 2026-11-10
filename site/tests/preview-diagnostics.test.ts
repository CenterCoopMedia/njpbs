import { describe, expect, it, vi } from "vitest";
import { previewDiagnostics } from "../scripts/preview-diagnostics";

const rendererSha = "a".repeat(40);
const queueId = "A".repeat(20);
describe("private preview stage diagnostics", () => {
  it("joins startup and job spans with bounded process identity and wall timestamps", async () => {
    const lines: string[] = [];
    const startupId = "11111111-1111-4111-8111-111111111111", processStartedAtMs = 1_790_000_000_000;
    await previewDiagnostics({ rendererSha, serializerId: "preview-next", startupId, processStartedAtMs, queueId },
      line => lines.push(line))("claim", async () => {});
    expect(lines.map(line => JSON.parse(line))).toEqual(["start", "end"].map(phase => expect.objectContaining({
      startupId, processStartedAtMs, serializerId: "preview-next", queueId, atMs: expect.any(Number), phase,
    })));
  });
  it("records only stage identity and elapsed time, never result or claim fields", async () => {
    const lines: string[] = [];
    let time = 12;
    const measure = previewDiagnostics({ rendererSha, queueId, claimToken: "secret" } as never,
      line => lines.push(line), () => time);
    const result = { draft: "private", token: "secret" };
    expect(await measure("render", async () => { time = 42; return result; })).toBe(result);
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { event: "cms_preview_stage", atMs: expect.any(Number), rendererSha, queueId, scope: "job", stage: "render", phase: "start" },
      { event: "cms_preview_stage", atMs: expect.any(Number), rendererSha, queueId, scope: "job", stage: "render", phase: "end", outcome: "ok", durationMs: 30 },
    ]);
  });
  it("preserves failure identity without logging exception text", async () => {
    const lines: string[] = [];
    const error = new Error("credential and draft content");
    const measure = previewDiagnostics({ rendererSha }, line => lines.push(line), () => 3);
    await expect(measure("public-context", async () => { throw error; })).rejects.toBe(error);
    expect(lines.join()).not.toContain(error.message);
    expect(JSON.parse(lines[1])).toMatchObject({ scope: "startup", outcome: "error", durationMs: 0 });
    expect(measure.timings()).toEqual({ "public-context": 0 });
  });
  it("does not let a broken clock or logger change an operation", async () => {
    const broken = () => { throw new Error("sink failed"); };
    const operation = vi.fn(async () => 7);
    expect(await previewDiagnostics({ rendererSha }, broken, broken)("upload", operation)).toBe(7);
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it("accumulates repeated stages and returns a detached timing snapshot", async () => {
    let time = 0;
    const measure = previewDiagnostics({ rendererSha }, () => {}, () => time);
    await measure("source-check", () => { time += 12; });
    const snapshot = measure.timings();
    await measure("source-check", () => { time += 8; });
    expect(snapshot).toEqual({ "source-check": 12 });
    snapshot["source-check"] = 999;
    expect(measure.timings()).toEqual({ "source-check": 20 });
  });
  it("retains successful and failed stage totals when the logger throws", async () => {
    let time = 0;
    const measure = previewDiagnostics({ rendererSha }, () => { throw new Error("broken logger"); }, () => time);
    await measure("render", () => { time += 25; });
    const failure = new Error("private error");
    await expect(measure("upload", () => { time += 10; throw failure; })).rejects.toBe(failure);
    expect(measure.timings()).toEqual({ render: 25, upload: 10 });
  });
  it("drops unknown stage names and malformed identities", async () => {
    const write = vi.fn();
    await previewDiagnostics({ rendererSha }, write)("draft@email.invalid", async () => 1);
    await previewDiagnostics({ rendererSha: "private text" }, write)("render", async () => 1);
    await previewDiagnostics({ rendererSha, queueId: "raw token" }, write)("render", async () => 1);
    expect(write).not.toHaveBeenCalled();
  });
});
