// @vitest-environment node
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("required accessibility CI gate", () => {
  const workflow = read("../../.github/workflows/ci.yml");

  it("scans the full build before the preview artifact replaces dist", () => {
    const fullBuild = workflow.indexOf("- name: Full build");
    const axeScan = workflow.indexOf("- name: Accessibility scan over full build");
    const previewBuild = workflow.indexOf("- name: Build PR preview artifact");

    expect(fullBuild).toBeGreaterThan(-1);
    expect(axeScan).toBeGreaterThan(fullBuild);
    expect(previewBuild).toBeGreaterThan(axeScan);
    expect(workflow).toContain("- name: Verify hosted Chrome security floor");
    expect(workflow).toContain('dpkg --compare-versions "$chrome_version" ge 156.0.8078.73');
    expect(workflow).not.toContain("python3 -m playwright install");
    expect(workflow).toContain("python3 ../qa/axe_scan.py");
    expect(workflow).toContain("--mode full");
    expect(workflow).toContain("--dist dist");
    expect(workflow).toContain(
      'node node_modules/astro/bin/astro.mjs preview --host 127.0.0.1 --port 4321 >"$RUNNER_TEMP/axe-preview.log" 2>&1 &',
    );
    expect(workflow).toContain("preview_pid=$!");
    // #2657: The 14-day successful maximum is 19:03; 3x rounds to 58 minutes.
    expect(parse(workflow).jobs.site["timeout-minutes"]).toBe(58);
  });
});
