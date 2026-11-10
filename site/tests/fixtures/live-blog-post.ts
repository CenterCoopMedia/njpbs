import type { LiveBlogData } from "../../../packages/content-core/src/live-blog";
import type { PostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import { postLeadFixture } from "./post-lead-media";

export const LIVE_BLOG_POST_AS_OF = "2026-10-25T15:00:00.000Z";
export const LIVE_BLOG_REPORTER_PHOTO = "https://media.njpbs.org/cms-media/live-blog-fixture/reporter.png";
export function liveBlogPostFixture({ sidebar = false, before = false, long = false, state = "ongoing", empty = false, media, archive = false, branding = false, updateKind, reporters = false, followUps, presentation, multipleCredits = false, multiDay = false }:
  { sidebar?: boolean; before?: boolean; long?: boolean; state?: LiveBlogData["coverageState"]; empty?: boolean; media?: PostLeadMedia["kind"]; archive?: boolean; branding?: boolean; updateKind?: "text" | "key" | "correction" | "withdrawal"; reporters?: boolean; followUps?: 1 | 3; presentation?: LiveBlogData["presentation"]; multipleCredits?: boolean; multiDay?: boolean } = {}) {
  const read = postLeadFixture("standard", "legacy");
  const metadata: Record<string, unknown> = { ...read.document.published.metadata,
    title: "Live coverage across New Jersey", summary: "Synthetic reporting for the local Post shell review.",
    slug: "live-blog-local", previousSlugs: [], date: "2026-10-25", editorialDateSource: "editorial", tags: [], categories: ["New Jersey"],
    credits: [{ kind: "custom", name: "Example newsroom" }], leadMedia: null, firstPublishedAt: LIVE_BLOG_POST_AS_OF,
  };
  for (const key of ["heroBackgroundImage", "heroImage", "meaningfulUpdatedAt", "meaningfulUpdatedBy", "firstPublishedBy", "seo", "excerpt"]) delete metadata[key];
  const body = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const credits = [{ kind: "custom" as const, name: "Example newsroom" }];
  const blog: LiveBlogData = { schemaVersion: 1, coverageState: state, updatedAt: LIVE_BLOG_POST_AS_OF, updates: empty ? [] : [
    { id: "entry-one", headline: long ? "W".repeat(230) : "Council confirms the meeting time", body: body(long ? "W".repeat(800) : "The meeting begins at 7 p.m. This is synthetic local reporting."),
      credits, publishedAt: LIVE_BLOG_POST_AS_OF, updatedAt: LIVE_BLOG_POST_AS_OF, keyUpdate: true },
    { id: "entry-two", headline: "Meeting location corrected", body: body("The meeting will be in the community room."),
      credits, publishedAt: "2026-10-25T14:59:00.000Z", updatedAt: LIVE_BLOG_POST_AS_OF, keyUpdate: false, correction: "An earlier update named the wrong room." },
    { id: "entry-three", headline: "Update withdrawn", body: { type: "doc", content: [] },
      credits, publishedAt: "2026-10-25T14:58:00.000Z", updatedAt: LIVE_BLOG_POST_AS_OF, keyUpdate: false, withdrawal: "The report could not be verified." },
  ] };
  const ids = ["1", "2", "3"].map(char => `au_${char.repeat(32)}`);
  const registered = (index: number) => ({ kind: "registered" as const, authorId: ids[index], displayName: ["Ada at publication", "Alex at publication", "Missing reporter"][index] });
  const authors = reporters ? [
    { id: ids[0], authorId: ids[0], slug: "ada-reporter", previousSlugs: [], displayName: "Ada Reporter", jobTitle: "Statehouse reporter",
      bio: "Covers state government and communities across New Jersey. More synthetic biography.", photo: { url: LIVE_BLOG_REPORTER_PHOTO, width: 800, height: 800, mimeType: "image/png" }, snapshotVersion: 1 },
    { id: ids[1], authorId: ids[1], slug: "alex-chen", previousSlugs: [], displayName: "Alex Chen", jobTitle: "Community reporter",
      bio: "Reports on local government and civic life across New Jersey.", photo: null, snapshotVersion: 1 },
  ] : [];
  if (reporters && blog.updates.length) {
    blog.updates[0].credits = [registered(0)];
    blog.updates[1].credits = [registered(1)];
    blog.updates.push({ ...blog.updates[0], id: "entry-missing", headline: "Reporting with a retained credit", credits: [registered(2)], keyUpdate: false, publishedAt: "2026-10-25T14:57:00.000Z" });
    if (multipleCredits) blog.updates[0].credits = [registered(0), registered(1), ...credits, registered(2)];
  }
  if (followUps && blog.updates.length) blog.updates[0].followUps = Array.from({ length: followUps }, (_, index) => ({
    id: `follow-${index}`, body: body(["The accessible entrance is on the east side.", "Staff will be available at the entrance.", "A staff member can direct visitors to seating."][index]),
    credits: reporters ? [registered(index % 2)] : credits, publishedAt: LIVE_BLOG_POST_AS_OF, updatedAt: LIVE_BLOG_POST_AS_OF,
  }));
  if (presentation) blog.presentation = presentation;
  if (updateKind) {
    blog.updates = [blog.updates[updateKind === "correction" ? 1 : updateKind === "withdrawal" ? 2 : 0]];
    if (updateKind === "text") blog.updates[0].keyUpdate = false;
  }
  let mediaAssets = [] as typeof read.assets;
  if (media && blog.updates[0]) {
    const selected = postLeadFixture("standard", media);
    blog.updates[0].media = (selected.document.published.metadata as Record<string, unknown>).leadMedia as PostLeadMedia;
    mediaAssets = selected.assets;
  }
  if (branding) blog.branding = "nj-decides-2026";
  if (archive) blog.updates = Array.from({ length: 53 }, (_, index) => ({ ...blog.updates[0], id: `archive-${index}`,
    headline: `Archive update ${index + 1}`, keyUpdate: index === 0 || index === 40,
    publishedAt: new Date(Date.parse(LIVE_BLOG_POST_AS_OF) - index * 60000).toISOString(),
    updatedAt: new Date(Date.parse(LIVE_BLOG_POST_AS_OF) - index * 60000).toISOString() }));
  if (multiDay) {
    const dates = [LIVE_BLOG_POST_AS_OF, "2026-10-25T03:59:00.000Z", "2026-10-25T03:58:00.000Z", "2026-10-24T03:58:00.000Z"];
    blog.updates.forEach((entry, index) => { entry.publishedAt = dates[index]; });
    blog.updates[1].followUps = ["2026-10-25T03:59:30.000Z", "2026-10-25T04:01:00.000Z", "2026-10-25T04:02:00.000Z"].map((publishedAt, index) => ({
      id: `day-follow-${index}`, body: body("Synthetic reporting across the station midnight boundary."), credits: blog.updates[1].credits,
      publishedAt, updatedAt: publishedAt,
    }));
  }
  const sidebarBlocks = sidebar ? [
    { id: "sidebar-copy", type: "prose", order: 1, visible: true, section: "post-live-blog-sidebar", data: { content: body("Coverage resources and ways to follow the newsroom.") } },
    { id: "sidebar-actions", type: "cta_row", order: 2, visible: true, section: "post-live-blog-sidebar", data: { ctas: [{ label: "Watch live coverage", href: "/live/" }] } },
  ] : [];
  const referenced = new Set(blog.updates.flatMap(entry => [...entry.credits, ...(entry.followUps ?? []).flatMap(item => item.credits)])
    .flatMap(credit => credit.kind === "registered" ? [credit.authorId] : []));
  if (!before) metadata.liveBlog = blog;
  return { ...read, assets: mediaAssets, authors: before ? [] : authors.filter(author => referenced.has(author.authorId)), document: { ...read.document, published: {
    ...read.document.published, publishedAt: LIVE_BLOG_POST_AS_OF, metadata,
    blocks: [{ id: "introduction", type: "prose", order: 0, visible: true, data: { content: body("Follow the latest reporting from communities across New Jersey. This local specimen contains no real event updates.") } }, ...sidebarBlocks],
  } } };
}
