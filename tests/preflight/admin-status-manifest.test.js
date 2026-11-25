import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAdminStatusManifest,
  encodeAdminStatusManifest,
} from "../../scripts/admin-status-manifest.mjs";

const STANDALONE_DEPLOY = fileURLToPath(
  new URL("../../scripts/deploy-admin.sh", import.meta.url),
);

const milestone = {
  number: 16,
  title: "M14: Admin interface + UX",
  state: "open",
  open_issues: 7,
  closed_issues: 30,
  updated_at: "2026-08-17T17:30:00Z",
  html_url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
};
const cmsMilestone = {
  number: 6,
  title: "M4: CMS + editorial workflow",
  state: "closed",
  open_issues: 8,
  closed_issues: 87,
  updated_at: "2026-08-24T15:15:06Z",
  html_url: "https://github.com/CenterCoopMedia/njpbs/milestone/6",
};
const milestones = [milestone, cmsMilestone];

describe("admin status build contract", () => {
  it("uses the transferred repository for milestone identity and refuses other owners", () => {
    const repository = "CenterCoopMedia/njpbs";
    const input = { environment: "Production", generatedAt: "2026-08-17T18:00:00.000Z",
      repository, revision: "d805028221a24448055bf0adcce344d1921547b7",
      milestones: milestones.map(value => ({ ...value, html_url: `https://github.com/${repository}/milestone/${value.number}` })) };
    expect(createAdminStatusManifest(input).milestone.url).toBe(`https://github.com/${repository}/milestone/16`);
    expect(() => createAdminStatusManifest({ ...input, repository: "other/njpbs-site" })).toThrow();
    expect(() => createAdminStatusManifest({ ...input, milestones: milestones.map(value => ({ ...value,
      html_url: `https://github.com/other/njpbs/milestone/${value.number}` })) })).toThrow();
  });
  it("converts the GitHub response to the exact public manifest", () => {
    const manifest = createAdminStatusManifest({
      environment: "Production",
      generatedAt: "2026-08-17T18:00:00.000Z",
      repository: "CenterCoopMedia/njpbs",
      revision: "d805028221a24448055bf0adcce344d1921547b7",
      milestones,
    });

    expect(manifest).toEqual({
      schemaVersion: 2,
      status: "current",
      environment: "Production",
      generatedAt: "2026-08-17T18:00:00.000Z",
      refreshAfter: "2026-08-20T18:00:00.000Z",
      build: {
        revision: "d805028221a24448055bf0adcce344d1921547b7",
        builtAt: "2026-08-17T18:00:00.000Z",
      },
      milestone: {
        number: 16,
        title: "M14: Admin interface + UX",
        state: "open",
        openIssues: 7,
        closedIssues: 30,
        updatedAt: "2026-08-17T17:30:00.000Z",
        url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
      },
      milestones: [
        {
          number: 6,
          title: "M4: CMS + editorial workflow",
          state: "closed",
          openIssues: 8,
          closedIssues: 87,
          updatedAt: "2026-08-24T15:15:06.000Z",
          url: "https://github.com/CenterCoopMedia/njpbs/milestone/6",
        },
        {
          number: 16,
          title: "M14: Admin interface + UX",
          state: "open",
          openIssues: 7,
          closedIssues: 30,
          updatedAt: "2026-08-17T17:30:00.000Z",
          url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
        },
      ],
    });
    expect(
      JSON.parse(Buffer.from(encodeAdminStatusManifest(manifest), "base64").toString("utf8")),
    ).toEqual(manifest);
  });

  it("features the earliest open milestone, or the latest when all are closed", () => {
    const build = list => createAdminStatusManifest({
      environment: "Production",
      generatedAt: "2026-08-17T18:00:00.000Z",
      repository: "CenterCoopMedia/njpbs",
      revision: "d805028221a24448055bf0adcce344d1921547b7",
      milestones: list,
    }).milestone.number;
    expect(build([{ ...milestone, state: "open" }, { ...cmsMilestone, state: "open" }])).toBe(6);
    expect(build([milestone, cmsMilestone])).toBe(16);
    expect(build([{ ...milestone, state: "closed" }, cmsMilestone])).toBe(16);
    expect(build([cmsMilestone])).toBe(6);
  });

  it.each([
    ["wrong repository URL", [{ ...milestone, html_url: "https://example.com/milestone/16" }]],
    ["negative counts", [{ ...milestone, open_issues: -1 }]],
    ["invalid update time", [{ ...milestone, updated_at: "not-a-date" }]],
  ])("refuses %s instead of publishing a false current state", (_label, badMilestones) => {
    expect(() => createAdminStatusManifest({
      environment: "Production",
      generatedAt: "2026-08-17T18:00:00.000Z",
      repository: "CenterCoopMedia/njpbs",
      revision: "d805028221a24448055bf0adcce344d1921547b7",
      milestones: badMilestones,
    })).toThrow(/admin status manifest/i);
  });

  it("makes the standalone production deploy fail closed and strips GitHub tokens from build processes", () => {
    const deploy = readFileSync(STANDALONE_DEPLOY, "utf8");
    const preparation = deploy.indexOf("prepare_admin_status_manifest");
    const credentialRead = deploy.indexOf('pass show "$TOKEN_KEY"');
    const build = deploy.indexOf("npm run admin:build");

    expect(preparation).toBeGreaterThan(-1);
    expect(credentialRead).toBeGreaterThan(preparation);
    expect(build).toBeGreaterThan(credentialRead);
    expect(deploy).toContain(
      'gh api "repos/$status_repo/milestones?state=all&sort=due_on&direction=asc&per_page=100"',
    );
    expect(deploy).toContain("gate 4, Admin status manifest");
    expect(deploy.indexOf("gate 4, Admin status manifest")).toBeLessThan(
      deploy.indexOf('echo "npm run admin:deploy would publish'),
    );
    expect(deploy).toContain("env -u GH_TOKEN -u GITHUB_TOKEN");
    expect(deploy).toContain(
      "env -u GH_TOKEN -u GITHUB_TOKEN node --input-type=module",
    );
    expect(deploy).toContain(
      "env -u GH_TOKEN -u GITHUB_TOKEN npx --yes wrangler@4",
    );
    expect(deploy).toContain(
      'env -u GH_TOKEN -u GITHUB_TOKEN CLOUDFLARE_API_TOKEN="$token"',
    );
    expect(deploy).toContain('ADMIN_STATUS_MANIFEST_BASE64="$admin_status_manifest"');
    expect(deploy).not.toContain("VITE_GITHUB");
  });


});
