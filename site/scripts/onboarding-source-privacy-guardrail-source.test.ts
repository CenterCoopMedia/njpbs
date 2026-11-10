import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scanner = join(repoRoot, "site/scripts/check-onboarding-source-privacy.mjs");
const guide = "site/src/pages/_admin-docs/first-session/index.md";
const register = "docs/onboarding/source-register.md";
const temporaryRoots: string[] = [];

function fixture(file: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), "onboarding-privacy-"));
  temporaryRoots.push(root);
  mkdirSync(dirname(join(root, guide)), { recursive: true });
  writeFileSync(join(root, guide), "# First session\n\nSign in to Boardwalk.\n");
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
  return root;
}

function scan(root: string) {
  const result = spawnSync(process.execPath, [scanner, "--root", root], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  return result;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("onboarding source privacy", () => {
  it("keeps the shared guide and any restored onboarding docs free of employee details", () => {
    const result = scan(repoRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Checked \d+ shared onboarding and guide sources/);
  });

  for (const file of [guide, register]) {
    it.each([
      ["start date", "Start date: Sept. 8"],
      ["named start", "Alex begins Sept. 8."],
      ["short name", "Li starts Sept. 8."],
      ["full name", "Alex Smith starts Sept. 8."],
      ["future start", "Alex will start Sept. 8."],
      ["progressive start", "Alex is starting Sept. 8."],
      ["ordinal date", "Alex begins Sept. 8th."],
      ["short numeric date", "Alex starts 9/8."],
      ["numeric date with year", "Alex starts on 9/8/2026."],
      ["relative date", "Alex joins next week."],
      ["uppercase time", "Alex arrives at 8 AM."],
      ["wrapped start", "Alex begins\nSept. 8."],
      ["wrapped start date", "Start\ndate: Sept. 8"],
      ["arrival", "Arrive about 8:30 a.m."],
      ["arrival time", "Arrival time: 8:30 a.m."],
      ["named arrival", "Alex arrives at the studio at 8:30 a.m."],
      ["private plan", "See the private plan for this employee."],
      ["personal email", "Contact: new.hire+onboarding@personal-mail.test"],
    ])("rejects %s in " + file, (_kind, detail) => {
      // The section supplies actual onboarding context without classifying names.
      const root = fixture(file, `# Employee onboarding\n\n${detail}\n`);
      const result = scan(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${file}:3:`);
      expect(result.stderr).toContain("Employee-specific onboarding detail");
      expect(result.stderr).toMatch(/\[(?:logistics|named-start|email)\]/);
      // Diagnostics identify the source without copying private content into CI logs.
      expect(result.stderr).not.toContain(detail);
    });
  }

  it("rejects a rephrased snapshot even when its email uses an example domain", () => {
    const root = fixture(register,
      "# Sources\n\n## Current snapshots\n\n" +
      "| C-99 | Contact alex@example.com | Hiring manager | High |\n" +
      "\n## Manager-supplied facts\n");
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${register}:5:`);
  });

  it.each(["editor-a@example.invalid", `unlisted-fixture@${"njpbs@montclair.edu".split("@")[1]}`])("rejects an unlisted individual email in the shared guide (%#)", address => {
    const root = fixture(guide, `# First session\n\nJane Doe (${address}).\n`);
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${guide}:3:`);
    expect(result.stderr).toContain("[email]");
    expect(result.stderr).not.toContain(address);
  });

  it("allows organizational facts, institutional contacts and guide examples", () => {
    const root = fixture(guide,
      "# First session\n\nContact njpbs@montclair.edu or user-0c949380b2@example.org.\n" +
      "Publish starts a public build. Cloudflare reports requests.\n" +
      "Publishing begins at the top of the hour. Upload starts at 0 percent.\n" +
      "Rendering starts with 2 amendments.\n" +
      "Monitoring starts 24/7. Playback starts at 25/1.\n" +
      "Wait for the verification email to arrive.\n" +
      "The tutorial chooses Sue Super (sue@example.org).\n");
    mkdirSync(dirname(join(root, register)), { recursive: true });
    writeFileSync(join(root, register),
      "# Sources\n\n## Current snapshots\n\n" +
      "| C-02 | The Aug. 30 Workday view showed open NJ PBS roles. | Workday | Talent Acquisition | High |\n" +
      "\n## Manager-supplied facts\n");
    const result = scan(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Checked 2 shared onboarding and guide sources");
  });

  it("rejects an explicit employee subject outside an onboarding section", () => {
    const result = scan(fixture(guide, "# First session\n\nNew hire Li will start Sept. 8.\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${guide}:3:`);
    expect(result.stderr).toContain("[named-start]");
    expect(result.stderr).not.toContain("Li");
  });

  it("allows scheduled product prose and synthetic example subdomains in guides", () => {
    const root = fixture(guide,
      "# First session\n\nPlayback starts at 10:30. Boardwalk starts tomorrow.\n" +
      "Publishing will start Sept. 8. Upload is starting next week.\n" +
      "Contact sue@training.example.org or alex@staff.training.example.com.\n");
    const result = scan(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [register, "Contact sue@training.example.org"],
    [guide, "| C-99 | Contact sue@training.example.org | Hiring manager | High |"],
    [guide, "Contact sue@notexample.org"],
  ])("keeps email exclusions outside the guide example allowance: %s %s", (file, detail) => {
    const result = scan(fixture(file, `# Sources\n\n${detail}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:3:`);
    expect(result.stderr).toContain("[email]");
    expect(result.stderr).not.toContain(detail);
  });

  it("fails closed when the current guide source is absent", () => {
    const root = fixture(register, "# Sources\n");
    rmSync(join(root, "site"), { recursive: true });
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Guide source is missing or empty");
  });

  it("fails closed when the current guide source is empty", () => {
    const root = fixture(guide, "# First session\n");
    rmSync(join(root, guide));
    const result = scan(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Guide source is missing or empty");
  });
});
