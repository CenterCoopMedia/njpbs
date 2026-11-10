import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MIGRATION_INPUTS, parseMigrationSelection, selectMigrations } from "../../scripts/lib/deployment-components.mjs";
import { releasePlanOutputLines } from "../../scripts/cms-release-plan.mjs";

const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
const steps = workflow.jobs.firebase.steps;
function selected(condition, functionsMutated, names) {
  if (!condition) return true;
  const expression = condition.match(/^needs\.firebase-preflight\.outputs\.functions_mutated == 'true' \|\| contains\(format\(',\{0\},', needs\.firebase-preflight\.outputs\.selected_migrations\), '([^']+)'\)$/);
  if (!expression) throw new Error("Unexpected migration selection expression");
  return functionsMutated || `,${names},`.includes(expression[1]);
}

describe("independent migration selection", () => {
  it.each(Object.entries(MIGRATION_INPUTS))("can run %s without a Functions release", (key, script) => {
    expect(parseMigrationSelection(key)).toEqual([key]);
    const step = steps.find(step => step.run?.includes(script));
    expect(step, script).toBeDefined();
    expect(selected(step.if, false, key)).toBe(true);
    for (const [other, path] of Object.entries(MIGRATION_INPUTS)) {
      if (other === key || other === "media-discovery") continue;
      expect(selected(steps.find(step => step.run?.includes(path)).if, false, key), path).toBe(false);
    }
  });

  it("keeps required code prerequisites and independent repair ordering", () => {
    const deploy = steps.findIndex(step => step.id === "deploy_functions");
    for (const [key, script] of Object.entries(MIGRATION_INPUTS)) {
      const index = steps.findIndex(step => step.run?.includes(script));
      expect(selected(steps[index].if, true, ""), key).toBe(true);
      if (["byline-projections", "media-discovery"].includes(key)) expect(index).toBeGreaterThan(deploy);
      else expect(index).toBeLessThan(deploy);
    }
    const plan = workflow.jobs["firebase-preflight"].steps.find(step => step.id === "release_plan");
    expect(plan.env.CMS_DEPLOY_MIGRATIONS).toBe("${{ inputs.migrations }}");
    expect(workflow.jobs["firebase-preflight"].outputs.selected_migrations).toBe("${{ steps.release_plan.outputs.selected_migrations }}");
    expect(parseMigrationSelection("")).toEqual([]);
    expect(parseMigrationSelection("author-profiles,content-sections")).toEqual(["author-profiles", "content-sections"]);
    expect(releasePlanOutputLines({}, { selectedMigrations: ["author-profiles", "content-sections"] }))
      .toContain("selected_migrations=author-profiles,content-sections");
  });

  it.each(["unknown", "author-profiles,author-profiles", "author-profiles,", " author-profiles", "__proto__", "author-profiles\nextra", null])("refuses invalid repair selection %j", value => {
    expect(() => parseMigrationSelection(value)).toThrow("Migration selection is invalid");
  });

  it("automatically selects edited repairs from immutable source without advancing a false done bit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "migration-selection-"));
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = () => {
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
      return git("rev-parse", "HEAD");
    };
    try {
      git("init", "-q"); mkdirSync(join(cwd, "scripts"));
      for (const file of Object.values(MIGRATION_INPUTS)) writeFileSync(join(cwd, file), "before");
      const baseline = commit();
      writeFileSync(join(cwd, MIGRATION_INPUTS["content-sections"]), "after");
      const source = commit();
      expect(await selectMigrations(baseline, source, [], { cwd })).toEqual(["content-sections"]);
      expect(await selectMigrations(baseline, source, ["content-sections", "author-profiles"], { cwd }))
        .toEqual(["author-profiles", "content-sections"]);
      expect(await selectMigrations(baseline, source, [], { cwd })).toEqual(["content-sections"]);
      expect(await selectMigrations(source, source, [], { cwd })).toEqual([]);
      writeFileSync(join(cwd, MIGRATION_INPUTS["author-profiles"]), "uncommitted");
      expect(await selectMigrations(source, source, [], { cwd })).toEqual([]);
      await expect(selectMigrations("a".repeat(40), source, [], { cwd })).rejects.toThrow();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("rejects an unknown repair before credentials or provider inspection", () => {
    try {
      execFileSync(process.execPath, [new URL("../../scripts/component-runner.mjs", import.meta.url).pathname, "functions", "plan"], {
        env: { CMS_DEPLOY_MIGRATIONS: "unknown", FIREBASE_SERVICE_ACCOUNT: "synthetic-private-value" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect.unreachable("unknown repair must fail");
    } catch (error) {
      expect(error.status).toBe(1);
      expect(error.stderr.toString()).toContain("Migration selection is invalid");
      expect(error.stderr.toString()).not.toContain("synthetic-private-value");
      expect(error.stderr.toString()).not.toContain("Firebase credentials");
    }
  });


});
