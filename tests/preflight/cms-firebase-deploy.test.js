import { describe, expect, it } from "vitest";
import { deployFirebase } from "../../scripts/lib/cms-firebase-deploy.mjs";

const quota = "Error: HTTP Error: 429, Quota exceeded for quota metric 'Per project mutation requests'\nFunctions deploy had errors with the following functions:\n\tcmsSaveContent(us-central1)\n";
// Firebase 15.36.0, a whole-codebase deploy with a live Function that the source does not export.
const asked = "\u001b[1m\u001b[31mError:\u001b[39m\u001b[22m The following functions are found in your project but do not exist in your local source code:\n" +
  "\tcmsGetBroadcastSchedule(us-central1)\n\tcmsGetPublishedSettings(us-central1)\n\nAborting because deletion cannot proceed in non-interactive mode.";
const targets = { development: ["njpbs-site-dev", "firebase.dev.json", "dev"], production: ["njpbs-site", "firebase.json", "default"] };

async function release(target, attempts = [], exported = ["health", "cmsSaveContent"]) {
  const [project, config, codebase] = targets[target], calls = [], waits = [], said = [];
  await deployFirebase({ project, config, codebase, exported, dev: target === "development", say: text => said.push(text),
    wait: async ms => { waits.push(ms); }, deploy: async args => { calls.push(args); return attempts.shift() ?? { ok: true }; } });
  return { calls, waits, said, only: calls.map(args => args[7]) };
}

describe("CMS Firebase deploy", () => {
  it.each([
    ["development", "firestore:rules,firestore:indexes"],
    ["production", "firestore:rules,firestore:indexes,storage"],
  ])("deploys the whole codebase on %s, so Firebase skips unchanged Functions", async (target, rules) => {
    const [project, config] = targets[target];
    const { calls } = await release(target);
    expect(calls).toEqual([
      ["firebase", "deploy", "--project", project, "--config", config, "--only", rules, "--non-interactive"],
      ["firebase", "deploy", "--project", project, "--config", config, "--only", "functions", "--non-interactive"],
    ]);
  });

  it.each([
    ["development", "functions:dev:health,functions:dev:cmsSaveContent"],
    ["production", "functions:health,functions:cmsSaveContent"],
  ])("names each export on %s when Firebase would delete a live Function, and deletes nothing", async (target, named) => {
    const { calls, only, said } = await release(target, [{ ok: true }, { ok: false, log: asked, error: new Error("exited 1") }]);
    expect(only.slice(1)).toEqual(["functions", named]);
    expect(said).toEqual(["Live Functions that the source does not export: cmsGetBroadcastSchedule, cmsGetPublishedSettings. They stay; each export is deployed by name."]);
    expect(calls.flat()).not.toContain("--force");
    expect(calls.flat().join(" ")).not.toContain("functions:delete");
  });

  it("repeats only the Functions a provider limit left", async () => {
    const { only, waits } = await release("production", [{ ok: true }, { ok: false, log: quota, error: new Error("exited 1") }]);
    expect(only).toEqual(["firestore:rules,firestore:indexes,storage", "functions", "functions:cmsSaveContent"]);
    expect(waits).toEqual([60_000]);
  });

  it("stops on a failure that no repeat can change, before Functions when the rules failed", async () => {
    const refused = new Error("firebase deploy exited 1");
    await expect(release("production", [{ ok: false, log: "Error: Permission denied", error: refused }])).rejects.toBe(refused);
  });

  it("stops when the named deploy still fails", async () => {
    const refused = new Error("firebase deploy exited 1");
    await expect(release("production", [{ ok: true }, { ok: false, log: asked, error: new Error("exited 1") }, { ok: false, log: "Error: Permission denied", error: refused }]))
      .rejects.toBe(refused);
  });

  it("refuses a source with no Function instead of deploying nothing by name", async () => {
    await expect(release("production", [{ ok: true }, { ok: false, log: asked, error: new Error("exited 1") }], [])).rejects.toThrow("The source exports no Function");
  });
});
