import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareEmulatorEnv } from "../../scripts/prepare-emulator-env.mjs";

const directories = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "emulator-env-"));
  directories.push(directory);
  mkdirSync(join(directory, "scripts/fixtures"), { recursive: true });
  mkdirSync(join(directory, "functions"));
  writeFileSync(join(directory, "scripts/fixtures/functions-emulator.env.example"), "BOOTSTRAP_SUPER_ADMINS=admin@example.org\nOPTIONAL_VALUE=false\n");
  return directory;
}
describe("clean-checkout emulator environment", () => {
  it("copies the synthetic fixture byte for byte before Firebase discovery", () => {
    const directory = fixture();
    expect(prepareEmulatorEnv(directory)).toBe(true);
    expect(readFileSync(join(directory, "functions/.env.local"))).toEqual(readFileSync(join(directory, "scripts/fixtures/functions-emulator.env.example")));
    expect(readFileSync(join(directory, "functions/.emulator-env.sha256"), "utf8")).toBe(
      createHash("sha256").update(readFileSync(join(directory, "functions/.env.local"))).digest("hex") + "\n");
  });
  it("accepts an exact existing fixture and is safe to repeat", () => {
    const directory = fixture();
    prepareEmulatorEnv(directory);
    expect(prepareEmulatorEnv(directory)).toBe(false);
    expect(prepareEmulatorEnv(directory)).toBe(false);
  });
  it("preserves custom local values while adding only missing synthetic defaults", () => {
    const directory = fixture();
    const original = "export BOOTSTRAP_SUPER_ADMINS=custom@example.org\nLOCAL_SETTING=preserved";
    writeFileSync(join(directory, "functions/.env.local"), original);
    expect(prepareEmulatorEnv(directory)).toBe(false);
    expect(readFileSync(join(directory, "functions/.env.local"), "utf8")).toBe(original + "\nOPTIONAL_VALUE=false\n");
    prepareEmulatorEnv(directory);
    expect(readFileSync(join(directory, "functions/.env.local"), "utf8")).toBe(original + "\nOPTIONAL_VALUE=false\n");
    expect(existsSync(join(directory, "functions/.emulator-env.sha256"))).toBe(false);
  });
  it("refreshes a stale generated copy with newly added fixture parameters", () => {
    const directory = fixture();
    prepareEmulatorEnv(directory);
    writeFileSync(join(directory, "scripts/fixtures/functions-emulator.env.example"), "BOOTSTRAP_SUPER_ADMINS=admin@example.org\nOPTIONAL_VALUE=false\nNEW_PARAMETER=\n");
    prepareEmulatorEnv(directory);
    expect(readFileSync(join(directory, "functions/.env.local")))
      .toEqual(readFileSync(join(directory, "scripts/fixtures/functions-emulator.env.example")));
  });
  it("preserves a customized managed copy instead of replacing its local values", () => {
    const directory = fixture();
    prepareEmulatorEnv(directory);
    const customized = "BOOTSTRAP_SUPER_ADMINS=custom@example.org\nOPTIONAL_VALUE=true\n";
    writeFileSync(join(directory, "functions/.env.local"), customized);
    writeFileSync(join(directory, "scripts/fixtures/functions-emulator.env.example"), "BOOTSTRAP_SUPER_ADMINS=admin@example.org\nOPTIONAL_VALUE=false\nNEW_PARAMETER=\n");
    prepareEmulatorEnv(directory);
    expect(readFileSync(join(directory, "functions/.env.local"), "utf8")).toBe(customized + "\nNEW_PARAMETER=\n");
  });
  it("migrates the previous approved synthetic fixture to the exact new bytes", () => {
    const directory = fixture();
    const current = readFileSync(new URL("../../scripts/fixtures/functions-emulator.env.example", import.meta.url), "utf8");
    const previous = current.split("\n# Optional non-secret parameters remain inert in the demo emulator.\n")[0];
    expect(createHash("sha256").update(previous).digest("hex")).toBe("1be673cbbe1ae41c1772adc2d8d2a15b4778832f7b12f1959167b4ee98ee68bb");
    writeFileSync(join(directory, "scripts/fixtures/functions-emulator.env.example"), current);
    writeFileSync(join(directory, "functions/.env.local"), previous);
    prepareEmulatorEnv(directory);
    expect(readFileSync(join(directory, "functions/.env.local"), "utf8")).toBe(current);
  });
  it.each([symlinkSync, linkSync])("refuses a linked receipt without changing its target (%s)", link => {
    const directory = fixture();
    const target = join(directory, "other.txt");
    writeFileSync(target, "preserved\n");
    link(target, join(directory, "functions/.emulator-env.sha256"));
    expect(() => prepareEmulatorEnv(directory)).toThrow("regular local file");
    expect(readFileSync(target, "utf8")).toBe("preserved\n");
  });
  it.each([false, true])("refuses a linked Functions directory before any write (existing local: %s)", existing => {
    const directory = fixture();
    const outside = mkdtempSync(join(tmpdir(), "outside-functions-"));
    directories.push(outside);
    rmSync(join(directory, "functions"), { recursive: true });
    symlinkSync(outside, join(directory, "functions"));
    if (existing) writeFileSync(join(outside, ".env.local"), "LOCAL_SETTING=preserved\n");
    expect(() => prepareEmulatorEnv(directory)).toThrow("real local directory");
    expect(existsSync(join(outside, ".emulator-env.sha256"))).toBe(false);
    if (existing) expect(readFileSync(join(outside, ".env.local"), "utf8")).toBe("LOCAL_SETTING=preserved\n");
    else expect(existsSync(join(outside, ".env.local"))).toBe(false);
  });
  it.each([symlinkSync, linkSync])("never appends defaults through a linked local environment (%s)", link => {
    const directory = fixture();
    const target = join(directory, "other.env");
    writeFileSync(target, "LOCAL_SETTING=preserved\n");
    link(target, join(directory, "functions/.env.local"));
    expect(() => prepareEmulatorEnv(directory)).toThrow("regular local file");
    expect(readFileSync(target, "utf8")).toBe("LOCAL_SETTING=preserved\n");
  });
  it("reports a missing fixture instead of silently starting unresolved Functions", () => {
    const directory = fixture();
    rmSync(join(directory, "scripts/fixtures/functions-emulator.env.example"));
    expect(() => prepareEmulatorEnv(directory)).toThrow();
  });
});
