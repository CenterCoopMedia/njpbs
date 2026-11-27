import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The deploy writes every Functions parameter into the runtime .env, using the table default when
// no variable is set. A code default that differs from the table default is therefore never used,
// and it hides a missing variable: the voiceover bucket's code default stopped applying once the
// deploy wrote the empty table default, and voiceover audio failed in production.
const table = JSON.parse(readFileSync("config/functions-configuration.json", "utf8"));

function codeDefaults(dir = "functions") {
  const found = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "fixtures", "tools"].includes(entry.name)) {
        for (const [name, value] of codeDefaults(path)) found.set(name, [...(found.get(name) ?? []), ...value]);
      }
    } else if (entry.name.endsWith(".js")) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/defineString\(\s*"([A-Z0-9_]+)"\s*,\s*\{[^}]*?default:\s*"([^"]*)"/gs)) {
        found.set(match[1], [...(found.get(match[1]) ?? []), { value: match[2], path }]);
      }
    }
  }
  return found;
}

describe("Functions parameter defaults", () => {
  it("match the code default for every optional variable-backed parameter", () => {
    const mismatches = [];
    for (const [name, defaults] of codeDefaults()) {
      const row = table.inputs[name];
      // Only rows filled from a GitHub variable fall back to the table default when it is unset.
      if (!row?.variable || row.required === true) continue;
      for (const { value, path } of defaults) {
        if (row.default !== value) mismatches.push(`${name}: table "${row.default}", ${path} "${value}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
