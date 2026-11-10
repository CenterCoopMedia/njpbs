import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const infrastructure = new URL("../../infrastructure/", import.meta.url);
const templates = readdirSync(infrastructure, { recursive: true })
  .filter((path) => path.endsWith(".json"))
  .map((path) => ({ path, template: JSON.parse(readFileSync(new URL(path, infrastructure), "utf8")) }))
  .filter(({ template }) => Object.hasOwn(template, "Resources"));

function nullPaths(value, path = "$") {
  if (value === null) return [path];
  if (typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => nullPaths(child, `${path}/${key}`));
}

describe("CloudFormation template values", () => {
  it("contains no JSON null values anywhere in infrastructure templates", () => {
    // CloudFormation rejected the cleanup ResultPath: 'null' values are not allowed in templates.
    expect(templates.length).toBeGreaterThan(0);
    for (const { path, template } of templates) {
      expect(nullPaths(template), path).toEqual([]);
    }
  });
});
