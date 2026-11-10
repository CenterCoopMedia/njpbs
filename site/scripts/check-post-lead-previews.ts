import assert from "node:assert/strict";
import { input, now } from "../tests/fixtures/cms-preview-content";
import { LEAD_LAYOUTS, postLeadFixture } from "../tests/fixtures/post-lead-media";

/** Existing compiled-preview CI probe and the focused Post-only local probe share this. */
export async function checkPostLeadPreviews(render: (value: ReturnType<typeof input>) => Promise<string>) {
  const results = [];
  for (const layout of LEAD_LAYOUTS) for (const kind of ["image", "library-video", "embed"] as const) {
    const saved = postLeadFixture(layout, kind);
    const published = structuredClone(saved.document.published);
    const metadata = published.metadata as Record<string, any>;
    if (kind === "image") metadata.leadMedia.data.alt = "";
    else {
      metadata.leadMedia.data.title = "";
      delete metadata.leadMedia.data.caption;
      if (kind === "library-video") delete metadata.leadMedia.data.public;
    }
    published.sourceVersion = 7;
    published.publishedAt = now.toISOString();
    const value = input("cmsPosts");
    Object.assign(value, { assets: saved.assets });
    Object.assign(value.snapshot, { published });
    const html = await render(value);
    assert.ok(html.includes("Coastal voices: a New Jersey story"), `${layout}/${kind}: header`);
    assert.ok(html.includes(kind === "image" ? "Frozen lead caption" : "data-post-lead-player"), `${layout}/${kind}: incomplete lead`);
    if (kind === "library-video") assert.ok(html.includes("cms-video__placeholder"), `${layout}: private placeholder`);
    if (kind === "embed") assert.ok(html.includes('aria-label="Play Video"'), `${layout}: fallback name`);
    results.push({ layout, kind, incompleteSelectionRetained: true, privatePlaceholder: kind === "library-video" });
  }
  assert.equal(results.length, 12);
  return results;
}
