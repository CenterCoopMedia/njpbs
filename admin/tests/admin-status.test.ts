import { describe, expect, it, vi } from "vitest";
import {
  classifyAdminStatus,
  fetchAdminStatus,
  parseAdminStatusManifest,
  type AdminStatusManifest,
} from "../src/lib/admin-status";

const cmsMilestone = {
  number: 6,
  title: "M4: CMS + editorial workflow",
  state: "open" as const,
  openIssues: 8,
  closedIssues: 87,
  updatedAt: "2026-08-24T15:15:06.000Z",
  url: "https://github.com/CenterCoopMedia/njpbs/milestone/6",
};
const adminMilestone = {
  number: 16,
  title: "M14: Admin interface + UX",
  state: "open" as const,
  openIssues: 7,
  closedIssues: 30,
  updatedAt: "2026-08-17T17:30:00.000Z",
  url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
};

const currentManifest: AdminStatusManifest = {
  schemaVersion: 2,
  status: "current",
  environment: "Production",
  generatedAt: "2026-08-17T18:00:00.000Z",
  refreshAfter: "2026-08-18T18:00:00.000Z",
  build: {
    revision: "d805028221a24448055bf0adcce344d1921547b7",
    builtAt: "2026-08-17T18:00:00.000Z",
  },
  milestone: adminMilestone,
  milestones: [cmsMilestone, adminMilestone],
};

describe("admin status manifest", () => {
  it("requires the configured repository for current milestone links", () => {
    for (const repository of ["", "other/repository", "https://github.com/owner/repository"]) {
      expect(() => parseAdminStatusManifest(currentManifest, repository)).toThrow();
    }
    expect(parseAdminStatusManifest(currentManifest, "CenterCoopMedia/njpbs")).toEqual(currentManifest);
  });
  it("accepts target repository milestone URLs while rejecting other repository owners", () => {
    const milestones = currentManifest.milestones.map(value => ({ ...value,
      url: `https://github.com/CenterCoopMedia/njpbs/milestone/${value.number}` }));
    const manifest = { ...currentManifest, milestones, milestone: milestones[1] };
    expect(parseAdminStatusManifest(manifest)).toEqual(manifest);
    expect(() => parseAdminStatusManifest({ ...manifest, milestone: { ...manifest.milestone,
      url: "https://github.com/other/njpbs-site/milestone/16" } })).toThrow();
  });
  it("accepts the documented current contract and marks it stale at refreshAfter", () => {
    expect(parseAdminStatusManifest(currentManifest)).toEqual(currentManifest);
    expect(
      classifyAdminStatus(currentManifest, Date.parse("2026-08-18T17:59:59.999Z")),
    ).toBe("current");
    expect(
      classifyAdminStatus(currentManifest, Date.parse("2026-08-18T18:00:00.000Z")),
    ).toBe("stale");
  });

  it("accepts an explicit unavailable build without inventing status details", () => {
    const manifest = parseAdminStatusManifest({
      schemaVersion: 2,
      status: "unavailable",
      environment: "Local",
      generatedAt: "2026-08-17T18:00:00.000Z",
      refreshAfter: "2026-08-17T18:00:00.000Z",
      build: null,
      milestone: null,
      milestones: null,
    });

    expect(manifest.status).toBe("unavailable");
    expect(classifyAdminStatus(manifest)).toBe("unavailable");
  });

  it.each([
    ["short revision", { build: { ...currentManifest.build, revision: "d805028" } }],
    [
      "wrong milestone destination",
      {
        milestone: {
          ...currentManifest.milestone,
          url: "https://example.com/CenterCoopMedia/njpbs/milestone/16",
        },
      },
    ],
    [
      "mismatched milestone number",
      {
        milestone: {
          ...currentManifest.milestone,
          url: "https://github.com/CenterCoopMedia/njpbs/milestone/15",
        },
      },
    ],
    ["negative issue count", { milestone: { ...currentManifest.milestone, openIssues: -1 } }],
    [
      "refresh before generation",
      { refreshAfter: "2026-08-16T18:00:00.000Z" },
    ],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      parseAdminStatusManifest({ ...currentManifest, ...patch }),
    ).toThrow(/admin status manifest/i);
  });

  it("loads only the same-origin asset without cache or cross-origin credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(currentManifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchAdminStatus("staff.token", fetcher)).resolves.toEqual(currentManifest);
    expect(fetcher).toHaveBeenCalledWith("/guide-content/admin-status.json", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", Authorization: "Bearer staff.token" },
    });
  });

  it("rejects a missing staff token before making a network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchAdminStatus("", fetcher)).rejects.toThrow("The signed-in session is unavailable.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on an HTTP error or invalid response", async () => {
    await expect(
      fetchAdminStatus("staff.token", vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 503 }))),
    ).rejects.toThrow("Admin status could not be loaded.");
    await expect(
      fetchAdminStatus(
        "staff.token",
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response('{"status":"current"}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    ).rejects.toThrow(/admin status manifest/i);
  });
});
