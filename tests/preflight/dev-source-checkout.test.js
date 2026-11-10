import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDevPublicationSourceHistory, checkoutDevPublicationSource } from "../../.github/scripts/dev-publication-source-checkout.mjs";

let cwd, first, second, trusted, unmerged;
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(value) {
  writeFileSync(join(cwd, "source.txt"), value);
  git("add", "source.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", value);
  return git("rev-parse", "HEAD");
}
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "dev-source-contract-"));
  git("init", "-b", "main");
  first = commit("Accepted first renderer");
  second = commit("Verified original run");
  trusted = commit("Trusted current main");
  git("checkout", "-b", "unmerged", first);
  unmerged = commit("Unmerged branch code");
  git("checkout", "main");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

it("checks out an accepted older main release without changing its source identity", () => {
  checkoutDevPublicationSource({ SOURCE_SHA: first, GITHUB_SHA: trusted }, { cwd });
  expect(git("rev-parse", "HEAD")).toBe(first);
});
it("checks out a retained release only inside the verified original run history", () => {
  checkoutDevPublicationSource({ SOURCE_SHA: first, GITHUB_SHA: trusted, DEV_RECONCILE_RUN_SHA: second }, { cwd });
  expect(git("rev-parse", "HEAD")).toBe(first);
});
it("keeps a repaired trusted reconciler while validating the retained source history", () => {
  expect(assertDevPublicationSourceHistory({ SOURCE_SHA: first, GITHUB_SHA: trusted, DEV_RECONCILE_RUN_SHA: second }, { cwd })).toBe(first);
  expect(git("rev-parse", "HEAD")).toBe(trusted);
});
it.each(["unmerged source", "newer than original run", "untrusted original run", "invalid source"])(
  "refuses %s before executing or checking out selected code", problem => {
    const env = { SOURCE_SHA: first, GITHUB_SHA: trusted };
    if (problem === "unmerged source") env.SOURCE_SHA = unmerged;
    if (problem === "newer than original run") Object.assign(env, { SOURCE_SHA: trusted, DEV_RECONCILE_RUN_SHA: second });
    if (problem === "untrusted original run") env.DEV_RECONCILE_RUN_SHA = unmerged;
    if (problem === "invalid source") env.SOURCE_SHA = "main; echo unsafe";
    expect(() => checkoutDevPublicationSource(env, { cwd })).toThrow();
    expect(git("rev-parse", "HEAD")).toBe(trusted);
  },
);
it("refuses source selection when the checked out code is not the trusted workflow SHA", () => {
  git("checkout", "--detach", second);
  expect(() => checkoutDevPublicationSource({ SOURCE_SHA: first, GITHUB_SHA: trusted }, { cwd })).toThrow("trusted checkout");
  expect(git("rev-parse", "HEAD")).toBe(second);
});
