import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const code = buildSync({ entryPoints: ["src/lib/cms-render-context.ts"], bundle: true,
  write: false, platform: "browser", format: "iife", globalName: "renderContext" }).outputFiles[0].text;

function evaluate(kind?: string, mode?: string) {
  const globals = mode === undefined ? {} : { process: { env: { CMS_CONTENT_MODE: mode } } };
  const context = kind ? { content: { kind } } : undefined;
  return runInNewContext(`${code}; renderContext.isPrivatePreviewRender(context)`, { ...globals, context });
}

describe("render context without Node globals", () => {
  it("uses exact projected Page cards, including an empty projection, without stale baked cards", () => {
    const execute = (context: unknown, collected: unknown[]) => runInNewContext(
      `${code}; renderContext.renderRecordCards(context, collected)`, { context, collected });
    const current = [{ id: "program", title: "Current published title" }];
    const baked = [{ id: "program", title: "Earlier baked title" }];
    expect(execute({ content: { kind: "private-preview", recordCards: current } }, baked)).toBe(current);
    expect(execute({ content: { recordCards: [] } }, baked)).toEqual([]);
    expect(execute(undefined, baked)).toBe(baked);
  });
  it("renders a public Post without process in the Worker runtime", () => {
    expect(evaluate("public-post-shadow")).toBe(false);
    expect(evaluate()).toBe(false);
  });
  it("keeps compiled private previews and build-based draft previews private", () => {
    expect(evaluate("private-preview")).toBe(true);
    expect(evaluate(undefined, " draft ")).toBe(true);
    expect(evaluate(undefined, "published")).toBe(false);
  });
  it("uses explicit published input even when a build has draft mode set", () => {
    expect(evaluate("public-post-shadow", "draft")).toBe(false);
  });
});
