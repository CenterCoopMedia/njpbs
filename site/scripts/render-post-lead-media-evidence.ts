import { cp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LEAD_LAYOUTS, LEAD_KINDS, postLeadFixture } from "../tests/fixtures/post-lead-media";

// Compile only astro.shadow.config.mjs in each checkout first. No loaders or services.
const root = resolve(process.argv[2] ?? "..");
const output = resolve(process.argv[3] ?? "../scratch/post-lead-media");
const phase = process.argv[4] ?? "after";
if (!["before", "after"].includes(phase)) throw new Error("Use before or after");
const renderer = await import(pathToFileURL(join(root, "site/.shadow-renderer/server/entry.mjs")).href);
const { projectPublishedPostRead } = await import(pathToFileURL(join(root, "site/src/lib/published-post-shadow.ts")).href);
await mkdir(join(output, phase), { recursive: true });
await cp(join(root, "site/.shadow-renderer/client"), join(output, phase, "client"), { recursive: true });
for (const layout of LEAD_LAYOUTS) for (const kind of LEAD_KINDS) {
  const read = postLeadFixture(layout, kind);
  const slug = String(read.document.published.metadata.slug);
  const content = projectPublishedPostRead(read, slug, renderer.rendererSha, new Date("2026-10-07T13:00:00Z"));
  const html = await renderer.renderPublishedPost(content);
  await writeFile(join(output, phase, `${layout}-${kind}.html`), html);
}
// Probe existing vertical-provider sizing and pasted iframe no-script navigation too.
if (phase === "after") for (const [provider, url] of Object.entries({
  tiktok: "https://www.tiktok.com/@njpbs/video/1234567890123456789",
  instagram: "https://www.instagram.com/reel/AbCdEf123/",
  facebook: "https://www.facebook.com/reel/123456789/",
  long: "https://youtu.be/dQw4w9WgXcQ",
  pasted: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"></iframe>',
})) {
  const read = postLeadFixture("multimedia", "embed");
  (read.document.published.metadata as any).leadMedia.data.url = url;
  if (provider === "long") Object.assign((read.document.published.metadata as any).leadMedia.data, { title: "W".repeat(190), caption: "W".repeat(590) });
  const content = projectPublishedPostRead(read, String(read.document.published.metadata.slug), renderer.rendererSha, new Date("2026-10-07T13:00:00Z"));
  await writeFile(join(output, phase, `provider-${provider}.html`), await renderer.renderPublishedPost(content));
}
await writeFile(join(output, `${phase}-source.json`), JSON.stringify({ rendererSha: renderer.rendererSha, root, phase }, null, 2));
await writeFile(join(output, "index.html"), '<!doctype html><title>Lead media evidence</title><main>' +
  ["before", "after"].flatMap(phase => LEAD_LAYOUTS.flatMap(layout => LEAD_KINDS.map(kind =>
    `<p><a href="/${phase}/${layout}-${kind}.html">${phase} ${layout} ${kind}</a></p>`))).join("") +
  ["tiktok", "instagram", "facebook", "pasted", "long"].map(provider => `<p><a href="/after/provider-${provider}.html">provider ${provider}</a></p>`).join("") + '</main>');
console.log(JSON.stringify({ phase, rendererSha: renderer.rendererSha, pages: 16, output }));
