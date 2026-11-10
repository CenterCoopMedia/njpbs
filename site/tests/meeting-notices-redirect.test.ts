import { describe, expect, it } from "vitest";
import worker from "../snippets/legacy-redirects/snippet.js";

describe("meeting notices permanent redirects", () => {
  it.each([
    ["/public-meetings", "/meeting-notices/"],
    ["/public-meetings/", "/meeting-notices/"],
    ["/closed-meetings/", "/meeting-notices/"],
    ["/public-meetings/njpba-audit-committee-2026-10-16.pdf", "/meeting-notices/njpba-audit-committee-2026-10-16.pdf"],
  ])("publishes a 301 for %s and preserves query parameters", async (source, destination) => {
    const response = await worker.fetch(new Request(`https://njpbs.org${source}?download=1&utm_source=notice`));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://njpbs.org${destination}?download=1&utm_source=notice`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
