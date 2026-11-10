import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const interactive = readFileSync(
  join(process.cwd(), "src", "components", "InteractiveDataPost.astro"),
  "utf8",
);

describe("Interactive/Data Lab presentation", () => {
  it("gives approved interactive links a keyboard-visible launch stage within the story", () => {
    expect(interactive).toContain("> .cms-block--embed");
    expect(interactive).toContain("min-height: var(--target-comfortable);");
    expect(interactive).toContain("outline: var(--focus-outline);");
    expect(interactive).toContain("overflow-wrap: anywhere;");
    expect(interactive).not.toMatch(/<iframe|<script|autoplay/i);
  });
});
