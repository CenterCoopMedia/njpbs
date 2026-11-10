import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { leadFixturePoster, leadFixturePublic } from "../tests/fixtures/post-lead-media";
import { LIVE_BLOG_POST_AS_OF, LIVE_BLOG_REPORTER_PHOTO, liveBlogPostFixture } from "../tests/fixtures/live-blog-post";

// Uses only the focused existing Post renderer and synthetic local input.
const output = resolve(process.argv[2] ?? "/tmp/live-blog-post-evidence");
const renderer = await import(pathToFileURL(resolve(".shadow-renderer/server/entry.mjs")).href);
await mkdir(output, { recursive: true });
await cp(resolve(".shadow-renderer/client"), join(output, "client"), { recursive: true });
// Compiled chunks also import the immutable asset prefix; keep this local proof offline.
for (const file of await readdir(join(output, "client"), { recursive: true })) {
  if (!/\.(?:js|css)$/.test(file)) continue;
  const path = join(output, "client", file);
  await writeFile(path, (await readFile(path, "utf8")).replaceAll("https://dev-public.example.org/posts/_shadow-assets", "/client"));
}
// Keep browser evidence self-contained: publication fixtures use non-existent immutable media URLs.
await cp(resolve("public/brand"), join(output, "brand"), { recursive: true });
// Optional local synthetic portrait; never fetch the fixture's non-existent URL.
const reporterPortrait = process.argv[3];
if (reporterPortrait) await cp(resolve(reporterPortrait), join(output, "fixture-reporter.png"));
const cases = { sidebar: { sidebar: true, media: "image", reporters: true, followUps: 3 }, "image-reporters": { media: "image", reporters: true, followUps: 3 }, text: { updateKind: "text" }, key: { updateKind: "key" }, correction: { updateKind: "correction" }, withdrawal: { updateKind: "withdrawal" }, before: { before: true }, after: {}, long: { long: true }, paused: { state: "paused" }, ended: { state: "ended" }, empty: { empty: true }, image: { media: "image", branding: true }, video: { media: "library-video", branding: true }, embed: { media: "embed" }, archive: { archive: true, branding: true }, "archive-media": { archive: true, media: "image", branding: true },
  reporters: { reporters: true }, "multiple-credits": { reporters: true, multipleCredits: true }, "follow-ups": { reporters: true, followUps: 3 }, "single-follow-up": { reporters: true, followUps: 1, updateKind: "text" },
  "photos-without-cards": { reporters: true, presentation: { reporterPhotos: true, reporterCards: false } },
  "cards-without-photos": { reporters: true, presentation: { reporterPhotos: false, reporterCards: true } },
  "plain-bylines": { reporters: true, presentation: { reporterPhotos: false, reporterCards: false } },
  "multi-day": { reporters: true, multiDay: true },
} as const;
for (const [name, options] of Object.entries(cases)) {
  const content = projectPublishedPostRead(liveBlogPostFixture(options), "live-blog-local", renderer.rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
  const html = (await renderer.renderPublishedPost(content)).replaceAll("https://dev-public.example.org/posts/_shadow-assets", "/client")
    .replaceAll(leadFixturePoster, "/brand/spotlight/politics-02.jpg")
    .replaceAll(LIVE_BLOG_REPORTER_PHOTO, reporterPortrait ? "./fixture-reporter.png" : "/brand/spotlight/politics-02.jpg")
    .replaceAll(leadFixturePublic.posterUrl, "/brand/spotlight/politics-02.jpg");
  await writeFile(join(output, `${name}.html`), html);
}
await writeFile(join(output, "source.json"), JSON.stringify({ rendererSha: renderer.rendererSha, cases: Object.keys(cases) }, null, 2));
console.log(JSON.stringify({ output, rendererSha: renderer.rendererSha, cases: Object.keys(cases) }));
