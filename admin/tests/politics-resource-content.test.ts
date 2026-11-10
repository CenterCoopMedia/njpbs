import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { politicsResourceContentPlugin } from "../build/politics-resource-content";
import { electionFixture } from "./fixtures/election-directory";
import researchFixture from "./fixtures/resources/nj-politics.json";
import catalogFixture from "./fixtures/resources/public-bios.json";

vi.mock("node:fs", () => {
  const readFileSync = vi.fn();
  const existsSync = vi.fn();
  return { existsSync, readFileSync, default: { existsSync, readFileSync } };
});

const research = JSON.stringify(researchFixture);
const catalog = JSON.stringify(catalogFixture);
function build(source = research, electionSource = JSON.stringify(electionFixture()), bioSource = catalog) {
  vi.mocked(existsSync).mockReset().mockReturnValue(true);
  vi.mocked(readFileSync).mockReset().mockImplementation((file) => {
    if (String(file).endsWith("/private-resources/nj-politics.json")) return source;
    if (String(file).endsWith("/private-resources/nj-election-2026.json")) return electionSource;
    if (String(file).endsWith("/private-resources/public-bios.json")) return bioSource;
    throw new Error(`Unexpected build input: ${String(file)}`);
  });
  const emitFile = vi.fn();
  const warn = vi.fn();
  const hook = politicsResourceContentPlugin().generateBundle;
  const generate = typeof hook === "function" ? hook : hook?.handler;
  if (!generate) throw new Error("Missing resource build hook");
  const run = () => generate.call({ emitFile, warn } as never, {} as never, {}, false);
  return { emitFile, warn, run };
}

describe("private NJ politics build assets", () => {
  it("warns and emits no resources when the optional corpus directory is absent", () => {
    const fixture = build();
    vi.mocked(existsSync).mockReturnValue(false);
    expect(fixture.run).not.toThrow();
    expect(fixture.warn).toHaveBeenCalledExactlyOnceWith("Politics resource corpus is absent; no resource assets will be emitted.");
    expect(readFileSync).not.toHaveBeenCalled();
    expect(fixture.emitFile).not.toHaveBeenCalled();
  });

  it("still fails for an incomplete corpus before emitting any asset", () => {
    const fixture = build();
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error("Missing input"), { code: "ENOENT" }); });
    expect(fixture.run).toThrow("Missing input");
    expect(fixture.emitFile).not.toHaveBeenCalled();
    expect(fixture.warn).not.toHaveBeenCalled();
  });
  it("emits research, election and bio data only at their exact staff-protected JSON paths", () => {
    const election = electionFixture();
    const fixture = build(research, JSON.stringify(election));
    fixture.run();
    expect(fixture.emitFile.mock.calls).toEqual([
      [{ type: "asset", fileName: "guide-content/resources/nj-politics.json", source: `${research}\n` }],
      [{ type: "asset", fileName: "guide-content/resources/nj-election-2026.json", source: `${JSON.stringify(election)}\n` }],
      [{ type: "asset", fileName: "guide-content/resources/public-bios.json", source: expect.stringMatching(/\n$/) }],
    ]);
    // The catalog parser preserves fields but writes them in canonical order.
    expect(JSON.parse(fixture.emitFile.mock.calls[2][0].source)).toEqual(JSON.parse(catalog));
    expect(vi.mocked(readFileSync).mock.calls).toEqual([
      [expect.stringMatching(/\/admin\/private-resources\/nj-politics\.json$/), "utf8"],
      [expect.stringMatching(/\/admin\/private-resources\/nj-election-2026\.json$/), "utf8"],
      [expect.stringMatching(/\/admin\/private-resources\/public-bios\.json$/), "utf8"],
    ]);
  });

  it.each(["schemaVersion", "meta", "sections", "people"])("rejects research missing %s before emitting any asset", (key) => {
    const invalid = JSON.parse(research);
    delete invalid[key];
    const fixture = build(JSON.stringify(invalid));
    expect(fixture.run).toThrow();
    expect(fixture.emitFile).not.toHaveBeenCalled();
  });

  it.each(["invalid JSON", "null", "[]", '"text"'])(
    "stops the build for invalid research input: %s",
    (source) => {
      const fixture = build(source);
      expect(fixture.run).toThrow();
      expect(fixture.emitFile).not.toHaveBeenCalled();
    },
  );

  it.each(["invalid JSON", "null", "[]", '"text"', "{}"])(
    "emits no asset when the second election input is invalid: %s",
    (source) => {
      const fixture = build(research, source);
      expect(fixture.run).toThrow();
      expect(readFileSync).toHaveBeenCalledTimes(2);
      expect(fixture.emitFile).not.toHaveBeenCalled();
    },
  );

  it.each(["invalid JSON", "null", "[]", "{}", '{"schemaVersion":2,"profiles":[]}'])(
    "emits no asset when the third bio catalog input is invalid: %s",
    (source) => {
      const fixture = build(research, JSON.stringify(electionFixture()), source);
      expect(fixture.run).toThrow();
      expect(fixture.emitFile).not.toHaveBeenCalled();
    },
  );

  it("validates election source provenance before emitting any asset", () => {
    const election = electionFixture();
    election.candidates[0].sourceId = "unrecognized-source";
    const fixture = build(research, JSON.stringify(election));
    expect(fixture.run).toThrow();
    expect(readFileSync).toHaveBeenCalledTimes(2);
    expect(fixture.emitFile).not.toHaveBeenCalled();
  });
});
