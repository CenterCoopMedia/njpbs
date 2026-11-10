import { describe, it, expect, vi } from "vitest";
import { createRundownClient, parseRundownReview, validSourceConfig } from "../src/lib/rundown-intake";
import { reviewView, sourceView } from "./rundown-fixtures";
describe("rundown API boundary", () => {
  it("uses only source, parser and review endpoints with exact source/draft bindings", async () => {
    const call = vi.fn(async (endpoint: string, _body: object) => endpoint === "cmsRundownSource" ? sourceView() : endpoint === "cmsRundownReview" ? { review: reviewView() } : {});
    const client = createRundownClient(call);
    await client.source("session"); await client.refresh("session", false); await client.extract("session", 1); await client.reconcile("session", 1);
    expect(call.mock.calls.map(([endpoint]) => endpoint)).toEqual(["cmsRundownSource", "cmsRundownSource", "cmsRundownParser", "cmsRundownReview"]);
    expect(call.mock.calls[1][1]).toEqual({ action: "refresh_source", sessionId: "session", manual: false });
    expect(call.mock.calls[3][1]).toEqual({ action: "reconcile", sessionId: "session", sourceGeneration: 1 });
  });
  it("rejects unsupported proposal types or missing source references instead of rendering guessed text", () => {
    const invalid = structuredClone(reviewView()); (invalid.changes[0].candidate!.text as unknown as { templateId: string }).templateId = "third_template";
    expect(() => parseRundownReview({ review: invalid })).toThrow();
    const missing = structuredClone(reviewView()); (missing.changes[0].candidate as unknown as { passages: unknown }).passages = null;
    expect(() => parseRundownReview({ review: missing })).toThrow();
  });
  it("requires exact IDs and distinct selected tabs", () => {
    expect(validSourceConfig({ documentId: "https://example.test/doc", tabIds: ["show"], enabled: true })).toBe(false);
    expect(validSourceConfig({ documentId: "synthetic_doc", tabIds: ["show", "show"], enabled: true })).toBe(false);
    expect(validSourceConfig({ documentId: "synthetic_doc", tabIds: ["show"], enabled: true })).toBe(true);
    expect(validSourceConfig({ documentId: "synthetic_doc", tabIds: ["t.0"], enabled: true })).toBe(true);
  });
});
