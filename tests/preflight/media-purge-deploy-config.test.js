import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import deployment from "../../functions/lib/media-purge-deployment.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = [];
afterEach(() => temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "purge-deploy-"));
  temporary.push(dir);
  return dir;
}
function resolve(configuration = {}) {
  const dir = directory();
  mkdirSync(join(dir, "functions"));
  writeFileSync(join(dir, "gcloud"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$PURGE_STUB_CALLS"\nprintf "%s\\n" "${PURGE_STUB_STATE:-ENABLED}"\n');
  chmodSync(join(dir, "gcloud"), 0o755);
  const calls = join(dir, "calls");
  const result = spawnSync("bash", [join(root, "scripts/resolve-media-purge.sh")], { cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PURGE_STUB_CALLS: calls,
      CMS_MEDIA_PURGE_SWEEP_ENABLED: "false", CMS_MEDIA_PURGE_REAL_DELETES_ENABLED: "false", ...configuration } });
  return { ...result, decision: deployment.readPurgeDeployment(join(dir, "functions/media-purge.generated.json"), {}),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}
describe("purge activation decision", () => {
  it("defaults disabled without credential metadata reads even if only real deletion was requested", () => {
    const result = resolve({ CMS_MEDIA_PURGE_REAL_DELETES_ENABLED: "true" });
    expect(result.status).toBe(0);
    expect(result.calls).toBe("");
    expect(result.decision).toEqual({ enabled: false, realDeletesEnabled: false });
  });
  it("binds an enabled dry-run decision only after all three secret versions are ready", () => {
    const result = resolve({ CMS_MEDIA_PURGE_SWEEP_ENABLED: "true" });
    expect(result.status).toBe(0);
    expect(result.decision).toEqual({ enabled: true, realDeletesEnabled: false });
    expect(result.calls.split("\n").filter(Boolean)).toHaveLength(3);
    expect(result.calls).toContain("--format=value(state)");
    expect(result.calls).not.toContain("access latest");
  });
  it("keeps a requested real-deletion deployment off if metadata is unavailable", () => {
    const result = resolve({ CMS_MEDIA_PURGE_SWEEP_ENABLED: "true", CMS_MEDIA_PURGE_REAL_DELETES_ENABLED: "true", PURGE_STUB_STATE: "DISABLED" });
    expect(result.decision).toEqual({ enabled: false, realDeletesEnabled: false });
  });
  it("requires the explicit real-deletion switch as well as ready credentials", () => {
    expect(resolve({ CMS_MEDIA_PURGE_SWEEP_ENABLED: "true", CMS_MEDIA_PURGE_REAL_DELETES_ENABLED: "true" }).decision)
      .toEqual({ enabled: true, realDeletesEnabled: true });
  });
  it("rejects a production decision in a different runtime project", () => {
    const path = join(directory(), "decision.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, projectId: "njpbs-site", enabled: true, realDeletesEnabled: true }));
    expect(deployment.readPurgeDeployment(path, { GCLOUD_PROJECT: "njpbs-site-dev" }))
      .toEqual({ enabled: false, realDeletesEnabled: false });
    expect(deployment.readPurgeDeployment(path, { GCLOUD_PROJECT: "njpbs-site" }))
      .toEqual({ enabled: true, realDeletesEnabled: true });
  });
  it.each([null, {}, [], { schemaVersion: 1, projectId: "other", enabled: true, realDeletesEnabled: true },
    { schemaVersion: 1, projectId: "njpbs-site", enabled: true, realDeletesEnabled: "true" }])(
    "fails closed on an invalid or foreign deployment decision %j", (value) => {
      const path = join(directory(), "decision.json");
      writeFileSync(path, JSON.stringify(value));
      expect(deployment.readPurgeDeployment(path)).toEqual({ enabled: false, realDeletesEnabled: false });
    },
  );
});


describe("purge runtime identity", () => {
  it.each([false, true])("isolates secret access only when deployment enabled=%s", (enabled) => {
    const module = { exports: {} };
    const localRequire = createRequire(join(root, "functions/media-purge-sweep.js"));
    const declared = [];
    runInNewContext(readFileSync(join(root, "functions/media-purge-sweep.js"), "utf8"), {
      module, fetch: () => { throw new Error("Discovery must not call a provider"); },
      require(name) {
        if (name === "./lib/media-purge-deployment") return { readPurgeDeployment: () => ({ enabled, realDeletesEnabled: false }) };
        if (name === "./lib/firebase") return { db: {} };
        if (name === "firebase-functions/v2/scheduler") return { onSchedule: (options) => options };
        if (name === "firebase-functions/params") return {
          defineString: () => ({ value: () => "" }),
          defineSecret: (secret) => {
            declared.push(secret);
            return { name: secret, value: () => { throw new Error("Discovery must not read credentials"); } };
          },
        };
        return localRequire(name);
      },
    });
    const options = module.exports.onMediaPurgeSweep;
    expect(options.serviceAccount).toBe(enabled ? "cms-media-purge@njpbs-site.iam.gserviceaccount.com" : undefined);
    expect(declared.sort()).toEqual(enabled ? ["CMS_MEDIA_PURGE_R2_ACCESS_KEY_ID", "CMS_MEDIA_PURGE_R2_SECRET_ACCESS_KEY", "HEALTHCHECKS_MEDIA_PURGE_SWEEP"] : []);
    expect(options.secrets.map((secret) => secret.name).sort()).toEqual(declared);
  });
});
