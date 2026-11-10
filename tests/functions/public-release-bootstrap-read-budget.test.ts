import { beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { releasePair } from "../helpers/private-public-release-pair.js";
const actual = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../site/scripts/bootstrap-public-release-selector", () => ({ prepareBootstrapQualificationGuard: actual.prepare }));
import { prepareMeasuredBootstrapQualification, BootstrapReadBudgetError } from "../../site/scripts/public-release-bootstrap-read-budget";
const attempt = { schemaVersion: 2 as const, operationId: "measurement", expectedSourceDigest: "a".repeat(64), currentPair: releasePair(),
  recoveryPair: releasePair("c", "c".repeat(40)), admittedContractDigest: "b".repeat(64), qualifications: [
    { qualificationId: "old-qualified", receiptDigest: "c".repeat(64) }, { qualificationId: "new-qualified", receiptDigest: "d".repeat(64) }] };
const guard = { begin: vi.fn() };
beforeEach(() => { actual.prepare.mockReset().mockResolvedValue(guard); });
it.each([1, 14_999, 15_000])("accepts a complete fresh full-closure measurement at %i ms, keeping the actual guard", async elapsed => {
  const clock = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(elapsed + 1);
  const result = await prepareMeasuredBootstrapQualification({ firestore: {} as any, attempt, clock });
  expect(result.qualificationGuard).toBe(guard); expect(result.measurement).toMatchObject({ completed: true, accepted: true,
    elapsedMilliseconds: elapsed, budgetMilliseconds: 30_000, maximumMilliseconds: 15_000 });
  expect(result.measurement.receiptDigest).toMatch(/^[a-f0-9]{64}$/); expect(actual.prepare).toHaveBeenCalledTimes(1);
});
it("records and refuses a completed measurement that leaves less than half the shared budget", async () => {
  const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(15_001);
  const error = await prepareMeasuredBootstrapQualification({ firestore: {} as any, attempt, clock }).catch(value => value);
  expect(error).toBeInstanceOf(BootstrapReadBudgetError);
  expect(error.measurement).toMatchObject({ completed: true, accepted: false, elapsedMilliseconds: 15_001 });
  expect(guard.begin).not.toHaveBeenCalled();
});
it("records an incomplete refusal without exposing the provider error", async () => {
  actual.prepare.mockRejectedValue(new Error("fixture-provider-private-canary"));
  const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(3);
  const error = await prepareMeasuredBootstrapQualification({ firestore: {} as any, attempt, clock }).catch(value => value);
  expect(error).toBeInstanceOf(BootstrapReadBudgetError); expect(error.measurement).toMatchObject({ completed: false, accepted: false });
  expect(JSON.stringify(error.measurement)).not.toContain("fixture-provider-private-canary");
});
it("bounds an unresponsive read-only preparation by the same caller abort", async () => {
  actual.prepare.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const result = prepareMeasuredBootstrapQualification({ firestore: {} as any, attempt, signal: controller.signal }); controller.abort();
  await expect(result).rejects.toBeInstanceOf(BootstrapReadBudgetError);
});
it("runs the actual Node22+tsx process launcher and refuses arguments before credentials", async () => {
  const child = spawn(process.execPath, ["--import", path.resolve("site/node_modules/tsx/dist/loader.mjs"), "scripts/bootstrap-public-release-initial.mjs", "--invalid"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(code).toBe(1); expect(output).toBe(""); expect(error).toBe("Initial public release selector was refused\n");
});
