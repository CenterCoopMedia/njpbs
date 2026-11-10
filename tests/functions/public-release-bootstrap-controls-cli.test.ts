import { expect, it } from "vitest";
import { getApps } from "firebase-admin/app";
import { parseBootstrapControlsOperatorArgs } from "../../site/scripts/bootstrap-public-release-controls";
it("defaults the named control operator to read-only without initializing ADC", () => {
  const apps = getApps().length;
  expect(parseBootstrapControlsOperatorArgs(["--attempt", "attempt.json"])).toEqual({ attemptFile: "attempt.json", dryRun: true });
  expect(parseBootstrapControlsOperatorArgs(["--attempt", "attempt.json", "--apply"])).toEqual({ attemptFile: "attempt.json", dryRun: false });
  expect(parseBootstrapControlsOperatorArgs(["--inspect", "--pair", "pair.json"])).toEqual({ pairFile: "pair.json", dryRun: true });
  expect(getApps().length).toBe(apps);
});
it.each([[], ["--apply"], ["--attempt"], ["--attempt", ""], ["--attempt", "a", "--force"],
  ["--attempt", "a", "--apply", "--apply"], ["--apply", "--attempt", "a"], ["--inspect", "--pair", ""],
  ["--inspect", "--pair", "a", "--apply"], ["--inspect", "a"]].map(args => ({ args })))("refuses ambiguous operator input $args", ({ args }) => {
  expect(() => parseBootstrapControlsOperatorArgs(args)).toThrow("controls were refused");
});
