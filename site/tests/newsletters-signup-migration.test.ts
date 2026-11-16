// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import type { Firestore } from "firebase-admin/firestore";
import mediaUsage from "../../functions/lib/media-usage.js";
import pageReaders from "../../functions/lib/page-reader-compatibility.js";
import { applyNewslettersSignup, planNewslettersSignup } from "../../scripts/migrate-newsletters-signup.mts";
const pageId = `page-${"7".repeat(32)}`;
const intro = { id: "intro", type: "prose", order: 0, visible: true, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Staff introduction" }] }] } } };
const before = { id: pageId, template: "genericPage", slug: "newsletters", version: 6, contentVersion: 9, status: "published",
  publiclyVisible: true, publicSourceVersion: 5, published: { sourceVersion: 5, metadata: { title: "Published copy" }, blocks: [intro] },
  blocks: [intro, { id: "later", type: "divider", order: 1, visible: true, data: {} }] };
afterEach(() => vi.restoreAllMocks());
function fake(document: Record<string, unknown> = structuredClone(before), history = false, lock?: Record<string, unknown>) {
  const writes: { method: string; path: string; value: Record<string, unknown> }[] = [];
  const tx = {
    getAll: async () => [{ exists: true, data: () => document }, { exists: history }, { exists: !!lock, data: () => lock }],
    update: (ref: { path: string }, value: Record<string, unknown>) => writes.push({ method: "update", path: ref.path, value }),
    create: (ref: { path: string }, value: Record<string, unknown>) => writes.push({ method: "create", path: ref.path, value }),
    set: (ref: { path: string }, value: Record<string, unknown>) => writes.push({ method: "set", path: ref.path, value }),
  };
  const firestore = { collection: (name: string) => ({ doc: (id = "fixture-audit") => ({ path: `${name}/${id}` }) }),
    runTransaction: async (callback: (tx: typeof tx) => unknown) => callback(tx) };
  vi.spyOn(mediaUsage, "prepareMediaUsageWrite").mockResolvedValue({ ref: { path: "cmsMediaUsage/fixture-working" }, document: { state: "working" } });
  vi.spyOn(pageReaders, "assertInstalledPageReaders").mockResolvedValue(undefined);
  return { firestore: firestore as unknown as Firestore, writes, document };
}
describe("draft-only newsletters migration", () => {
  it("runs the operator fixture dry-run without credentials or writes", () => {
    const output = execFileSync(new URL("../node_modules/.bin/tsx", import.meta.url).pathname, [
      new URL("../../scripts/migrate-newsletters-signup.mts", import.meta.url).pathname,
      "--fixture", new URL("./fixtures/newsletters-signup-draft.json", import.meta.url).pathname,
    ], { encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ mode: "dry-run", changed: true, version: 6,
      blocks: [{ id: "intro", type: "prose", order: 0, visible: true },
        { id: "newsletters-signup", type: "embed_anchor", order: 1, visible: true }] });
  });
  it("inserts after the intro without changing staff content or an existing moved/hidden signup", () => {
    const plan = planNewslettersSignup(before);
    expect(plan.blocks.map(block => block.id)).toEqual(["intro", "newsletters-signup", "later"]);
    expect(plan.blocks[0]).toEqual(intro);
    expect({ ...plan.blocks[2], order: 1 }).toEqual(before.blocks[1]);
    expect(before.blocks.map(block => block.id)).toEqual(["intro", "later"]);
    const moved = { ...before, blocks: [{ ...plan.blocks[1], order: 0, visible: false }, { ...intro, order: 1 }] };
    expect(planNewslettersSignup(moved)).toEqual({ changed: false, blocks: moved.blocks });
    const row = { ...before, blocks: [{ id: "row", type: "row", order: 0, visible: true, data: { columns: [6, 6] } },
      { ...intro, order: 1, layout: { rowId: "row", column: 0 } },
      { ...intro, id: "second-column", order: 2, layout: { rowId: "row", column: 1 } }] };
    expect(planNewslettersSignup(row).blocks.map(block => block.id)).toEqual(["row", "intro", "second-column", "newsletters-signup"]);
  });

  it("updates only the draft, revision, working usage and audit", async () => {
    const state = fake();
    expect(await applyNewslettersSignup(state.firestore, pageId, 6)).toEqual({ changed: true, version: 7, status: "draft" });
    expect(state.writes.map(write => write.method)).toEqual(["update", "create", "set", "create"]);
    expect(state.writes[0].path).toBe(`cmsPages/${pageId}`);
    expect(Object.keys(state.writes[0].value).sort()).toEqual(["blocks", "contentVersion", "status", "updatedAt", "updatedBy", "version"]);
    expect(state.writes[0].value).toMatchObject({ status: "draft", version: 7, contentVersion: 10 });
    expect(state.writes[1].value.before).toEqual(before);
    expect((state.writes[1].value.after as typeof before).published).toEqual(before.published);
    expect(state.document).toEqual(before);
    expect(pageReaders.assertInstalledPageReaders).toHaveBeenCalledWith(expect.objectContaining({ pageId, preview: true,
      blocks: expect.arrayContaining([expect.objectContaining({ type: "embed_anchor" })]) }));
  });

  it("writes nothing for changed drafts, active editors or completed migrations", async () => {
    const newer = fake({ ...before, version: 7 });
    await expect(applyNewslettersSignup(newer.firestore, pageId, 6)).rejects.toThrow(/Page changed/);
    expect(newer.writes).toEqual([]);
    const active = fake(structuredClone(before), false, { heartbeatAt: { toMillis: () => Date.now() } });
    await expect(applyNewslettersSignup(active.firestore, pageId, 6)).rejects.toThrow(/active Page editor/);
    expect(active.writes).toEqual([]);
    const removedByStaff = fake(structuredClone(before), true);
    expect(await applyNewslettersSignup(removedByStaff.firestore, pageId, 6)).toEqual({ changed: false, reason: "already-migrated" });
    expect(removedByStaff.writes).toEqual([]);
  });

  it("writes no draft when installed readers cannot accept the new plank", async () => {
    const state = fake();
    vi.mocked(pageReaders.assertInstalledPageReaders).mockRejectedValue(new Error("Page reader unavailable"));
    await expect(applyNewslettersSignup(state.firestore, pageId, 6)).rejects.toThrow("Page reader unavailable");
    expect(state.writes).toEqual([]);
  });
});
