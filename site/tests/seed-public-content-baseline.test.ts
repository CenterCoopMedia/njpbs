// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { baselineOperatorErrorMessage, parseBaselineArguments } from "../scripts/seed-public-content-baseline";
import { ContentBaselineError } from "../../packages/content-core/src/public-content-baseline";

const args = ["--target", "production", "--dist", "/retained/dist", "--prepared", "/retained/prepared.json"];
it("defaults the operator to local preparation and requires an explicit apply flag", () => {
  expect(parseBaselineArguments(args)).toMatchObject({ apply: false, distDirectory: "/retained/dist", preparedPath: "/retained/prepared.json" });
  expect(parseBaselineArguments([...args, "--apply"]).apply).toBe(true);
});
it("reports controlled refusals while withholding provider error details", () => {
  expect(baselineOperatorErrorMessage(new ContentBaselineError("The retained baseline bytes differ")))
    .toBe("The retained baseline bytes differ");
  expect(baselineOperatorErrorMessage(new Error("synthetic private provider detail")))
    .toBe("Baseline preparation refused; verify the sealed artifact and storage readback");
});
it.each([[], [...args, "--unknown"], ["--target", "preview", ...args.slice(2)],
  ["--target", "production", "--dist", "relative", ...args.slice(4)]].map(args => ({ args })))("refuses invalid operator arguments $args", ({ args: value }) => {
  expect(() => parseBaselineArguments(value)).toThrow("Usage:");
});
it("refuses an invalid target before dependency loading or any credential descriptor read", () => {
  const script = fileURLToPath(new URL("../scripts/seed-public-content-baseline.ts", import.meta.url));
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", loader, script, "--target", "preview", ...args.slice(2)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toMatch(/^Usage:/);
  expect(child.stderr).not.toMatch(/EBADF|Cannot find|credential|firebase-admin/);
});
