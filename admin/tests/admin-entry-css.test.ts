import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function source(relativePath: string) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("Boardwalk entry CSS", () => {
  it("keeps signed-out entry CSS to the shared sheet", () => {
    const entry = source("src/main.tsx");
    const app = source("src/App.tsx");
    expect(entry).toContain('import "./styles.css"');
    expect(entry).not.toContain("content-scan-flow.css");
    expect(entry).not.toContain("cms-workspace.css");
    expect(entry).not.toContain("editor-layout-mode.css");
    expect(entry).not.toContain("EditorLayoutMode");
    expect(app).not.toContain("content-scan-flow.css");
    expect(app).not.toContain("cms-workspace.css");
    expect(app).not.toMatch(/MediaRoute\.css|StaffRoute\.css|workflow-surfaces\.css/);
  });

});
