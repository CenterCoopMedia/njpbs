import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/pages.yml", import.meta.url), "utf8");
const gate = workflow.split("      - name: Require reviewed deploy ref\n")[1]
  .split("      - name:")[0].split("        run: |\n")[1]
  .replace(/^          /gm, "");

test("uses reviewed source identity and rejects unreviewed promotion trees", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pages-reviewed-source-"));
  const outputs = mkdtempSync(join(tmpdir(), "pages-gate-outputs-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const commit = (tree, parents, message) => git("commit-tree", tree,
    ...parents.flatMap((parent) => ["-p", parent]), "-m", message);
  try {
    git("init", "--quiet");
    const tree = git("mktree");
    const root = commit(tree, [], "root");
    const reviewed = commit(tree, [root], "reviewed");
    const main = commit(tree, [reviewed], "main");
    git("update-ref", "refs/remotes/origin/main", main);
    const production = commit(tree, [root], "production");
    const promotion = commit(tree, [production, reviewed], "promotion");
    const unreviewed = commit(tree, [root], "unreviewed");
    const unreviewedPromotion = commit(tree, [production, unreviewed], "unreviewed promotion");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"],
      { cwd, env, input: "production-only change", encoding: "utf8" }).trim();
    const changedTree = execFileSync("git", ["mktree"],
      { cwd, env, input: `100644 blob ${blob}\tchanged.txt\n`, encoding: "utf8" }).trim();
    const changedPromotion = commit(changedTree, [production, reviewed], "changed promotion");

    for (const [head, expected] of [
      [reviewed, reviewed], [promotion, reviewed], [unreviewed, null],
      [unreviewedPromotion, null], [changedPromotion, null],
    ]) {
      git("checkout", "--quiet", "--detach", head);
      const output = join(outputs, `output-${head}`);
      mkdirSync(join(cwd, ".release-gate"));
      writeFileSync(join(cwd, ".release-gate", "gate.mjs"), "trusted gate fixture");
      const result = spawnSync("bash", ["-c", gate], {
        cwd, env: { ...env, GITHUB_OUTPUT: output, DEPLOY_REF: head }, encoding: "utf8",
      });
      assert.equal(result.status, expected ? 0 : 1, result.stderr || result.stdout);
      if (expected) assert.equal(readFileSync(output, "utf8"), `source_sha=${expected}\n`);
      assert.equal(existsSync(join(cwd, ".release-gate")), false);
      assert.equal(git("status", "--porcelain"), ""); // exact-source renderer admission
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outputs, { recursive: true, force: true });
  }
});

test("passes the reviewed source to artifact selection and build identity", () => {
  const capture = workflow.split("      - name: Capture production artifact source\n")[1]
    .split("      - name:")[0];
  assert.match(capture, /REVIEWED_SOURCE_SHA: \$\{\{ steps\.reviewed_ref\.outputs\.source_sha \}\}/);
  assert.match(capture, /echo "sha=\$REVIEWED_SOURCE_SHA"/);
  assert.match(workflow, /SOURCE_SHA: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(workflow, /PUBLIC_BUILD_COMMIT_SHA: .*steps\.source\.outputs\.sha/);
});
