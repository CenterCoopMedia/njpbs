// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

for (const name of ["pages", "cms-publish"]) {
  describe(`${name} content refresh`, () => {
    const workflow = parse(readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}.yml`, import.meta.url)), "utf8"));
    const steps = workflow.jobs.build.steps;
    const launch = steps.find((step: { name?: string }) => step.name === "Refresh Media Manager content");
    const refresh = steps.find((step: { name?: string }) => step.name === "Refresh external content concurrently");

    it("keeps provider and media-write credentials out of public syncs and their live ancestors", () => {
      const root = mkdtempSync(path.join(tmpdir(), "content-sync-isolation-"));
      roots.push(root);
      // Substitute only the npm process boundary. Read the real Linux process
      // environments: env -u hides a key from a child but leaves its parent exposed.
      writeFileSync(path.join(root, "npm"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const source = process.argv[3].replace("sync:", "");
const credentials = [];
let pid = process.pid;
while (pid !== Number(process.env.TEST_RUNNER_PID)) {
  credentials.push(...fs.readFileSync("/proc/" + pid + "/environ", "utf8")
    .split("\\0").filter(entry => /^(MEDIA_MANAGER_API_(KEY|SECRET)|CMS_MEDIA_R2_(ACCESS_KEY_ID|SECRET_ACCESS_KEY))=/.test(entry)));
  pid = Number(fs.readFileSync("/proc/" + pid + "/status", "utf8").match(/^PPid:\\s+(\\d+)/m)[1]);
  if (!pid) throw new Error("Test runner is not an ancestor");
}
fs.writeFileSync(path.join(process.env.TEST_ROOT, source + ".json"), JSON.stringify({
  credentials,
  fresh: process.env.REQUIRE_FRESH_CONTENT,
  key: process.env.MEDIA_MANAGER_API_KEY,
  secret: process.env.MEDIA_MANAGER_API_SECRET,
}));
`, { mode: 0o755 });
      const fixtureValues: Record<string, string> = {
        "${{ secrets.MEDIA_MANAGER_API_KEY }}": "fixture-key",
        "${{ secrets.MEDIA_MANAGER_API_SECRET }}": "fixture-secret",
        "${{ needs.authorize.outputs.require_fresh }}": "1",
      };
      const syncSteps = steps.filter((step: { run?: string }) => /npm run sync:/.test(step.run ?? ""));
      for (const step of syncSteps) {
        const env = Object.fromEntries(Object.entries({
          ...workflow.env, ...workflow.jobs.build.env, ...step.env,
        }).map(([key, value]) => [key, fixtureValues[String(value)] ?? String(value)]));
        const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
          env: { ...env, PATH: `${root}:${process.env.PATH}`, TEST_ROOT: root, TEST_RUNNER_PID: String(process.pid) },
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      }
      for (const source of ["launch-content", "spotlight-news", "schedule"]) {
        const observed = JSON.parse(readFileSync(path.join(root, `${source}.json`), "utf8"));
        expect(observed.fresh).toBe("1");
        expect(observed.key).toBe(source === "launch-content" ? "fixture-key" : undefined);
        expect(observed.secret).toBe(source === "launch-content" ? "fixture-secret" : undefined);
        if (source === "launch-content") {
          expect(observed.credentials).toEqual(expect.arrayContaining([
            "MEDIA_MANAGER_API_KEY=fixture-key", "MEDIA_MANAGER_API_SECRET=fixture-secret",
          ]));
        } else {
          expect(observed.credentials, source).toEqual([]);
        }
      }
    });

    it("keeps refreshes before CMS credentials and the snapshot reservation", () => {
      expect(launch).toBeDefined();
      expect(refresh).toBeDefined();
      const refreshIndex = steps.indexOf(refresh);
      const configureIndex = steps.findIndex((step: { name?: string }) => /Configure.*credentials/.test(step.name ?? ""));
      expect(steps.indexOf(launch)).toBeLessThan(refreshIndex);
      expect(refreshIndex).toBeLessThan(configureIndex);
      expect(launch.env.REQUIRE_FRESH_CONTENT).toBe(name === "cms-publish" ? "1" : "${{ needs.authorize.outputs.require_fresh }}");
      expect(refresh.env.REQUIRE_FRESH_CONTENT).toBe(name === "cms-publish" ? "1" : "${{ needs.authorize.outputs.require_fresh }}");
    });

    it.each([0, 1])("propagates Media Manager exit status %s before public refreshes", (status) => {
      const root = mkdtempSync(path.join(tmpdir(), "content-sync-launch-"));
      roots.push(root);
      writeFileSync(path.join(root, "npm"), `#!${process.execPath}
process.exit(Number(process.env.TEST_STATUS));
`, { mode: 0o755 });
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", launch.run], {
        env: { PATH: `${root}:${process.env.PATH}`, TEST_STATUS: String(status) },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
      // Actions must stop on a failed Media Manager step; public feed code
      // must not run through always() or a softened failure condition.
      expect(launch["continue-on-error"]).toBeUndefined();
      expect(refresh.if).toBeUndefined();
    });

    it.each(["", "spotlight-news", "schedule"])("waits for every public refresh and fails closed for %s", (failure) => {
      expect(refresh).toBeDefined();
      const root = mkdtempSync(path.join(tmpdir(), "content-sync-test-"));
      roots.push(root);
      // Run the actual workflow shell with a fake npm. Each child must observe
      // both public feed starts before it can finish, so a serial implementation fails.
      writeFileSync(path.join(root, "npm"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const name = process.argv[3].replace("sync:", "");
const root = process.env.TEST_ROOT;
fs.writeFileSync(path.join(root, name + ".started"), JSON.stringify({
  fresh: process.env.REQUIRE_FRESH_CONTENT,
  key: process.env.MEDIA_MANAGER_API_KEY,
  secret: process.env.MEDIA_MANAGER_API_SECRET,
}));
const deadline = Date.now() + 3000;
const timer = setInterval(() => {
  const started = fs.readdirSync(root).filter(name => name.endsWith(".started"));
  if (started.length !== 2) {
    if (Date.now() > deadline) process.exit(99);
    return;
  }
  clearInterval(timer);
  setTimeout(() => {
    fs.writeFileSync(path.join(root, name + ".finished"), "done");
    process.exit(name === process.env.FAIL_SYNC ? 1 : 0);
  }, name === process.env.FAIL_SYNC ? 0 : 100);
}, 10);
`, { mode: 0o755 });
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", refresh.run], {
        env: {
          PATH: `${root}:${process.env.PATH}`,
          TEST_ROOT: root,
          FAIL_SYNC: failure,
          REQUIRE_FRESH_CONTENT: "1",
        },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(failure ? 1 : 0);
      expect(readdirSync(root).filter((name) => name.endsWith(".finished"))).toHaveLength(2);
      for (const source of ["spotlight-news", "schedule"]) {
        const env = JSON.parse(readFileSync(path.join(root, `${source}.started`), "utf8"));
        expect(env.fresh).toBe("1");
        expect(env.key).toBeUndefined();
        expect(env.secret).toBeUndefined();
      }
    });
  });
}
