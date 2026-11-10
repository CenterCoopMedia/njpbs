// @vitest-environment node
// Regression guard for the Astro accessibility lint gate (issue #339). It proves
// the gate actually reports the three failure classes #339 requires it to catch,
// by linting deliberately-bad snippets through the project's real eslint.config.js
// with the ESLint Node API. If a future config edit drops one of these rules, the
// gate would go quiet without any existing page turning red; this fails instead.
import { describe, it, expect, beforeAll } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
// Not written to disk — the path only has to match the config's **/*.astro glob
// so the Astro parser and a11y rules apply. lintText does not read the file.
const fixturePath = fileURLToPath(
  new URL("../src/__a11y_gate_fixture__.astro", import.meta.url),
);

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: siteRoot });
});

async function lint(code: string) {
  const [result] = await eslint.lintText(code, { filePath: fixturePath });
  return result;
}
const ruleIds = (result: Awaited<ReturnType<typeof lint>>) =>
  result.messages.map((m) => m.ruleId);

describe("the a11y lint gate reports the failures #339 requires (#339)", () => {
  it("flags a positive tabindex", async () => {
    expect(ruleIds(await lint(`<div tabindex="5">x</div>`))).toContain(
      "astro/jsx-a11y/tabindex-no-positive",
    );
  });

  it("flags a redundant ARIA role", async () => {
    expect(ruleIds(await lint(`<button role="button">Save</button>`))).toContain(
      "astro/jsx-a11y/no-redundant-roles",
    );
  });

  it("flags an invalid ARIA role", async () => {
    expect(ruleIds(await lint(`<div role="not-a-real-role">x</div>`))).toContain(
      "astro/jsx-a11y/aria-role",
    );
  });

  it("flags a missing accessible name on an interactive element (empty anchor)", async () => {
    expect(ruleIds(await lint(`<a href="/somewhere"></a>`))).toContain(
      "astro/jsx-a11y/anchor-has-content",
    );
  });

  it("stays quiet on accessible markup", async () => {
    const result = await lint(`<a href="/somewhere">Go somewhere</a>`);
    expect(result.errorCount).toBe(0);
    expect(ruleIds(result)).not.toContain("astro/jsx-a11y/anchor-has-content");
  });
});
