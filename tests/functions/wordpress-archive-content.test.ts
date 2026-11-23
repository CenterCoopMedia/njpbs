import { readFileSync } from "node:fs";
import { getSchema } from "@tiptap/core";
import { expect, it } from "vitest";
import { richTextExtensions } from "../../admin/src/lib/rich-text";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import converter from "../../functions/wordpress-archive-content.js";

const { convertWordPressStory } = converter;
const sourceRef = { source: "sample-archive", postId: "3561" };
const permalink = "https://archive.example.org/stories/harbor/";
const mediaByUrl = new Map([
  ["https://archive.example.org/uploads/harbor.jpg", "harbor_asset"],
  ["https://archive.example.org/uploads/pier.jpg", "pier_asset"],
]);
const fixture = (name: string) => readFileSync(new URL(`../fixtures/wordpress-archive/${name}.html`, import.meta.url), "utf8");
const convert = (html: string) => convertWordPressStory({ html, sourceRef, permalink, mediaByUrl });
const schema = getSchema(richTextExtensions());

function checkEditableBlocks(blocks: unknown) {
  const parsed = parseBlocks(blocks);
  if (!parsed.ok) throw new Error(parsed.error);
  for (const block of parsed.blocks) {
    if (block.type === "prose") schema.nodeFromJSON(block.data.content).check();
  }
  return parsed.blocks;
}

it("produces editable story blocks and renders media, captions and corrections in order", () => {
  const story = convert(fixture("common"));
  expect(story.report).toEqual({ sourceRef, status: "complete", issues: [] });
  expect(convert(fixture("common"))).toEqual(story);
  expect(story.blocks.map(block => [block.type, block.order])).toEqual([
    ["prose", 0], ["image", 1], ["data_table", 2], ["embed", 3], ["prose", 4],
  ]);
  const [intro, photo, table, video, correction] = checkEditableBlocks(story.blocks).map(block => renderBlock(block, {
    resolveAsset: assetId => assetId === "harbor_asset" ? { url: "https://media.example.org/harbor.jpg" } : null,
  }));
  expect(intro).toContain("<h2>Harbor restoration</h2>");
  expect(intro).toContain('href="https://archive.example.org/stories/background/">background &amp; timeline</a>');
  expect(intro).toContain("<blockquote><p>The walkway will stay open.</p><p>Harbor commission</p></blockquote>");
  expect(intro).toContain("<ul><li><p>Dock repairs</p><ul><li><p>North pier</p></li></ul></li></ul>");
  expect(photo).toContain('href="https://archive.example.org/photo/"');
  expect(photo).toContain('alt="A path along the harbor"');
  expect(photo).toContain("Harbor path. Photo: Archive desk");
  expect(table).toContain("<caption>Harbor projects</caption>");
  expect(table).toContain("<td>North, East</td><td>The &quot;Pier&quot; plan</td>");
  expect(video).toContain('src="https://www.youtube-nocookie.com/embed/AbC123xYz_0?start=12"');
  expect(video).toContain("Public meeting video");
  expect(correction).toContain("<strong>Correction:</strong> The vote took place on Tuesday.");
});

it("reports lossy or unsupported source regions while keeping safe text and linked credit", () => {
  const html = fixture("unusual");
  const { blocks, report } = convert(html);
  expect(report).toMatchObject({ sourceRef, status: "manual_review" });
  expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
    "heading_level", "missing_media", "unsupported_embed", "unsafe_link", "malformed_html",
    "interactive_markup", "hidden_markup", "code_formatting", "shortcode",
    "dynamic_block", "unsupported_block", "unsupported_table",
  ]));
  const unsupported = report.issues.find(issue => issue.code === "unsupported_block")!;
  expect(html.slice(unsupported.start, unsupported.end)).toMatch(/^<!-- wp:example\//);
  expect(JSON.stringify(report)).not.toMatch(/private-content|https:|A recovered paragraph|Archive desk/);
  const rendered = checkEditableBlocks(blocks).map(block => renderBlock(block)).join("");
  expect(rendered).toContain("<p>Opening from a classic story.<br><em>A line from City Hall.</em><br>The next line follows.</p>");
  expect(rendered).toContain("<p>Next paragraph with [Note] and [gallery].</p>");
  expect(rendered).toMatch(/<p>A recovered paragraph<\/p><p>Later paragraph<\/p>.*<h3>Deeper heading<\/h3>/s);
  expect(rendered).toContain('<a href="https://archive.example.org/credits/">Archive desk</a>');
  expect(rendered).toContain("<p>Link label survives</p>");
  expect(rendered).toContain('<strong><a href="https://archive.example.org/formula/">the formula</a></strong>');
  expect(rendered).toContain('<a href="https://x.com/harbor/status/123456789">View post on X</a>');
  expect(rendered).toContain("<p>Last line of the story.</p>");
  expect(rendered).not.toMatch(/<iframe|<script|<img|private-content|Watch video on X|\[gallery ids/);
});

it("preserves classic paragraphs inside quotes, attributed paragraphs and list items", () => {
  const { blocks, report } = convert(`<blockquote>First quote.

Second quote.</blockquote>
<p style="text-align:center">First line.
Second line.</p>
<ul><li>First item line.
Second item line.</li></ul>

https://vimeo.com/123456789`);
  expect(report.status).toBe("complete");
  const rendered = checkEditableBlocks(blocks).map(block => renderBlock(block)).join("");
  expect(rendered).toContain("<blockquote><p>First quote.</p><p>Second quote.</p></blockquote>");
  expect(rendered).toContain("<p>First line.<br>Second line.</p>");
  expect(rendered).toContain("<ul><li><p>First item line.<br>Second item line.</p></li></ul>");
  expect(rendered).toContain('src="https://player.vimeo.com/video/123456789?dnt=1"');

  const damagedHeading = convert("<h2><p>A title in a paragraph</p></h2>");
  expect(damagedHeading.report.status).toBe("manual_review");
  expect(renderBlock(checkEditableBlocks(damagedHeading.blocks)[0])).toContain("<p>A title in a paragraph</p>");
});

it.each([
  '<ol start="2"><li>First</li><li>Second</li></ol>',
  '<ol type="a"><li>First</li><li>Second</li></ol>',
  '<ol reversed><li>First</li><li>Second</li></ol>',
  '<ol><li>First</li><li value="5">Second</li></ol>',
])("flags unsupported ordered-list numbering while keeping list entries in order", (html) => {
  const { blocks, report } = convert(html);
  expect(report).toMatchObject({ status: "manual_review", issues: [{ code: "list_layout", start: 0, end: html.length }] });
  expect(renderBlock(checkEditableBlocks(blocks)[0])).toBe("<ol><li><p>First</p></li><li><p>Second</p></li></ol>");
});

it("converts legacy gallery and provider markup with scheme-relative URLs", () => {
  const { blocks, report } = convert(`<!-- wp:gallery -->
<figure><ul class="blocks-gallery-grid">
  <li class="blocks-gallery-item"><figure><a href="//archive.example.org/photo/">
    <img src="//archive.example.org/uploads/harbor.jpg" alt="Harbor">
  </a><figcaption>Harbor credit</figcaption></figure></li>
  <li class="blocks-gallery-item"><figure><img src="/uploads/pier.jpg" alt="Pier"></figure></li>
</ul></figure>
<!-- /wp:gallery -->
<!-- wp:core-embed/youtube -->
<figure><iframe src="//www.youtube.com/embed/AbC123xYz_0"></iframe></figure>
<!-- /wp:core-embed/youtube -->`);
  expect(report.status).toBe("complete");
  expect(checkEditableBlocks(blocks)).toMatchObject([
    { type: "image", data: { assetId: "harbor_asset", href: "https://archive.example.org/photo/", caption: "Harbor credit" } },
    { type: "image", data: { assetId: "pier_asset" } },
    { type: "embed", data: { url: "https://www.youtube-nocookie.com/embed/AbC123xYz_0" } },
  ]);

  const credentialLink = convert('<p><a href="//author@archive.example.org/story/">Read the story</a></p>');
  expect(credentialLink.report.issues).toContainEqual(expect.objectContaining({ code: "unsafe_link" }));
  expect(renderBlock(checkEditableBlocks(credentialLink.blocks)[0])).toBe("<p>Read the story</p>");
});

it("reports standalone classic URLs whose providers need manual review", () => {
  const html = "Read the dispatch.\n\nhttps://twitter.com/harbor/status/123456789\n\nhttps://audio.example.org/episode";
  const { blocks, report } = convert(html);
  expect(report).toMatchObject({
    status: "manual_review", issues: [{ code: "unsupported_embed", start: 0, end: html.length }],
  });
  expect(renderBlock(checkEditableBlocks(blocks)[0])).toBe('<p>Read the dispatch.</p>'
    + '<p><a href="https://x.com/harbor/status/123456789">View post on X</a></p>'
    + '<p><a href="https://audio.example.org/episode">https://audio.example.org/episode</a></p>');
});

it("distinguishes empty input from source that requires review before import", () => {
  expect(convert("<!-- ordinary comment --> \n")).toEqual({
    blocks: [], report: { sourceRef, status: "skipped", issues: [] },
  });
  expect(convert("<!-- wp:block {\"ref\":17} /-->")).toMatchObject({
    blocks: [], report: { status: "manual_review", issues: [{ code: "dynamic_block" }] },
  });
  expect(convert("<div>".repeat(51) + "Too deep" + "</div>".repeat(51))).toMatchObject({
    blocks: [], report: { status: "manual_review", issues: [{ code: "body_limit" }] },
  });
  expect(convert("<hr>".repeat(201))).toMatchObject({
    blocks: [], report: { status: "manual_review", issues: [{ code: "post_block_limit" }] },
  });
});
