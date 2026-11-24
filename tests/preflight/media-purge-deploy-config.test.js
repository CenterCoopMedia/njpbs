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
  writeFileSync(join(dir, "gcloud"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$PURGE_STUB_CALLS"\nif [[ -n "${PURGE_STUB_ERROR:-}" && "$(wc -l < "$PURGE_STUB_CALLS")" -le "${PURGE_STUB_FAILURES:-9999}" ]]; then printf "%s\\n" "$PURGE_STUB_ERROR" >&2; exit 1; fi\nprintf "%s\\n" "${PURGE_STUB_STATE:-ENABLED}"\n');
  chmodSync(join(dir, "gcloud"), 0o755);
  const calls = join(dir, "calls");
  const result = spawnSync("bash", [join(root, "scripts/resolve-media-purge.sh")], { cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PURGE_STUB_CALLS: calls,
      CMS_MEDIA_PURGE_SWEEP_ENABLED: "false", CMS_MEDIA_PURGE_REAL_DELETES_ENABLED: "false", ...configuration } });
  const decision = join(dir, "functions/media-purge.generated.json");
  return { ...result, written: existsSync(decision), decision: deployment.readPurgeDeployment(decision, {}),
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
  it("stays disabled when the provider names the version absent", () => {
    const result = resolve({ CMS_MEDIA_PURGE_SWEEP_ENABLED: "true",
      PURGE_STUB_ERROR: "ERROR: (gcloud.secrets.versions.describe) NOT_FOUND: Secret not found or has no versions." });
    expect(result.status).toBe(0);
    expect(result.calls.split("\n").filter(Boolean)).toHaveLength(1);
    expect(result.decision).toEqual({ enabled: false, realDeletesEnabled: false });
  });
  it("asks again until the provider answers an unavailable state read", () => {
    const result = resolve({ CMS_MEDIA_PURGE_SWEEP_ENABLED: "true", PURGE_STUB_FAILURES: "1",
      PURGE_STUB_ERROR: "ERROR: (gcloud.secrets.versions.describe) UNAVAILABLE: The service is currently unavailable." });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.split("\n").filter(Boolean)).toHaveLength(4);
    // Only a provider answer ends the read; the retry line names the check and that answer.
    expect(result.stderr).toContain("check=secret version HEALTHCHECKS_MEDIA_PURGE_SWEEP got=ERROR: (gcloud.secrets.versions.describe) UNAVAILABLE");
    expect(result.decision).toEqual({ enabled: true, realDeletesEnabled: false });
  });
  it("fails loud and writes no decision when the state read is refused", () => {
    const result = resolve({ CMS_MEDIA_PURGE_SWEEP_ENABLED: "true",
      PURGE_STUB_ERROR: "ERROR: (gcloud.secrets.versions.describe) PERMISSION_DENIED: Permission denied" });
    expect(result.status).toBe(1);
    expect(result.calls.split("\n").filter(Boolean)).toHaveLength(1);
    expect(result.stderr).toContain("class permission, attempt 1, last provider line: ");
    expect(result.stderr).toContain("could not be read");
    expect(result.written).toBe(false);
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
