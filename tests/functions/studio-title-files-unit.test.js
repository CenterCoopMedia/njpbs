import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

function run(value) {
  const script = `
    const assert = require('node:assert/strict');
    require('./functions/live-production.js');
    const reader = require('./functions/lib/studio-title-files.js');
    const specs = require('firebase-functions/params').declaredParams.map(param => param.toSpec());
    assert(specs.some(param => param.name === 'CMS_STUDIO_TITLE_FILES' && param.type === 'string'));
    process.stdout.write(JSON.stringify(reader.readStudioTitleFiles()));`;
  const env = { PATH: process.env.PATH, METADATA_SERVER_DETECTION: "none" };
  if (value !== undefined) env.CMS_STUDIO_TITLE_FILES = value;
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
}

describe("trusted Studio filename supplier", () => {
  it("reads the required deployment configuration without a runtime lookup", () => {
    const files = { headline: "synthetic-headline.gtzip", name_title: "synthetic-name-title.gtzip" };
    const result = run(JSON.stringify(files));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(files);
  });

  it.each([undefined, "", "{}", JSON.stringify({ headline: "REPLACE_ME.gtzip", name_title: "synthetic-name-title.gtzip" })])(
    "fails closed for missing or invalid configuration: %s", value => {
      const result = run(value);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("null");
    });
});
