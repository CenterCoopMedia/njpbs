import assert from "node:assert/strict";
import test from "node:test";
import { requireReviewedDevSource } from "./require-reviewed-dev-source.mjs";

const repository = "CenterCoopMedia/njpbs";
const sha = "a".repeat(40);
const base = "b".repeat(40);
const pull = {
  number: 42, state: "open", draft: false,
  head: { sha, repo: { full_name: repository } }, base: { ref: "main", repo: { full_name: repository } },
};
const review = {
  context: "cross-review/claude", state: "success",
  target_url: `https://github.com/${repository}/compare/${base}...${sha}#patch=${"c".repeat(40)}`,
};

function check({ pulls = [pull], statuses = [review], comparison = { status: "ahead" }, source = sha } = {}) {
  return requireReviewedDevSource({ repository, sha: source, request: async (path) => {
    if (path.startsWith(`/repos/${repository}/commits/${sha}/pulls`)) return pulls;
    if (path.startsWith(`/repos/${repository}/commits/${sha}/status`)) return { sha, total_count: statuses.length, statuses };
    if (path.startsWith(`/repos/${repository}/compare/${base}...main`)) {
      return { base_commit: { sha: base }, merge_base_commit: { sha: base }, ...comparison };
    }
    throw new Error(`unexpected ${path}`);
  } });
}

test("admits the reviewed head of an open pull request into main", async () => {
  assert.equal(await check(), 42);
});

test("refuses every other development source", async (t) => {
  const cases = {
    "no pull request": { pulls: [] },
    "closed pull request": { pulls: [{ ...pull, state: "closed" }] },
    "draft pull request": { pulls: [{ ...pull, draft: true }] },
    "moved head": { pulls: [{ ...pull, head: { ...pull.head, sha: "d".repeat(40) } }] },
    "fork head": { pulls: [{ ...pull, head: { ...pull.head, repo: { full_name: "someone/fork" } } }] },
    "stacked base": { pulls: [{ ...pull, base: { ...pull.base, ref: "lower-layer" } }] },
    "no review": { statuses: [{ context: "ci", state: "success" }] },
    "failed review": { statuses: [review, { ...review, context: "cross-review/codex", state: "failure" }] },
    "review of another head": { statuses: [{ ...review, target_url: review.target_url.replace(sha, "e".repeat(40)) }] },
    "review base outside main": { comparison: { status: "diverged" } },
    "invalid sha": { source: "main; echo unsafe" },
  };
  for (const [name, input] of Object.entries(cases)) {
    await t.test(name, async () => { await assert.rejects(check(input)); });
  }
});
