import type { LiveBlogData, LiveBlogUpdate } from "../../../packages/content-core/src/live-blog";

const prose = (text: string): LiveBlogUpdate["body"] => ({
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Synthetic copy only; this fixture is not an election result or a stored Post. */
export const LIVE_BLOG_SPECIMEN: LiveBlogData = {
  schemaVersion: 1, coverageState: "ongoing", updatedAt: "2026-11-04T03:00:00Z",
  updates: [
    {
      id: "opening", headline: "Coverage opens",
      body: prose("This synthetic update demonstrates the reusable editorial feed. Reporting and verified source links will appear here."),
      credits: [{ kind: "custom", name: "Example newsroom" }],
      publishedAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z", keyUpdate: true,
    },
    {
      id: "source", headline: "A source note with a longer headline that wraps on a phone",
      body: prose("Use visible source attribution in each update. This is demonstration copy; it does not report a real event or make a race call."),
      credits: [{ kind: "custom", name: "Example A" }, { kind: "custom", name: "Example B" }],
      publishedAt: "2026-11-04T01:00:00Z", updatedAt: "2026-11-04T02:30:00Z", keyUpdate: false,
      correction: "This specimen demonstrates a visible correction. The original publication time and update link stay the same.",
    },
    {
      id: "latest", headline: "New information appears first",
      body: prose("A future reader enhancement should offer new entries without shifting the update someone is reading. This scaffold provides the static document first."),
      credits: [{ kind: "custom", name: "Example newsroom" }],
      publishedAt: "2026-11-04T02:00:00Z", updatedAt: "2026-11-04T02:00:00Z", keyUpdate: true,
    },
  ],
};
