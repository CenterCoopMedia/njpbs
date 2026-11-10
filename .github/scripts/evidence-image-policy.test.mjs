import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./evidence-image-policy.mjs", import.meta.url));

function check(t, paths, untracked = []) {
  const cwd = mkdtempSync(join(tmpdir(), "evidence-image-policy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd });
  for (const path of [...paths, ...untracked]) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), "fixture");
  }
  execFileSync("git", ["add", "--", ...paths], { cwd });
  return spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
}

test("keeps application assets, guide images, and golden/test fixtures", (t) => {
  const result = check(t, [
    "admin/tests/visual/baselines/home.png", "admin/public/brand/auth.webp",
    "admin/src/dev/fixtures/photo.webp", "site/public/favicon.png",
    "site/src/internal/admin-guide/library.webp", "site/tests/fixtures/photo.jpg",
    "branding/logo.png", "functions/assets/logo.png",
    "premiere-boardwalk-panel/icons/icon.png",
    "docs/njpbs-digital-content-playbook/assets/logo.png",
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects evidence extensions and lookalike asset folders", (t) => {
  const paths = ["notes/screenshots/screen.PNG", "notes/screen.jpg",
    "evidence/screen.jpeg", "notes/screen.gif", "screen.webp",
    "site/publicity/screen.png", "admin/tests/visual/baselines-copy/screen.png",
    "docs/a screenshot\nwith newline.png"];
  const result = check(t, paths);
  assert.equal(result.status, 1);
  for (const path of paths) assert.ok(result.stderr.includes(JSON.stringify(path)));
});

test("ignores capture scripts and untracked local screenshots", (t) => {
  const result = check(t, ["notes/screenshots/capture.mjs"], ["notes/screenshots/local.png"]);
  assert.equal(result.status, 0, result.stderr);
});
