/** Stable Post-to-registry identity, shared by the bounded source catalogs. */
export function isCoverageLabelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/** Legacy election live blogs chose their identity before Post pills existed. */
export function postCoverageLabelId(post: { coverageLabelId?: unknown; liveBlog?: unknown }): string | undefined {
  if (post.coverageLabelId !== undefined) return isCoverageLabelId(post.coverageLabelId) ? post.coverageLabelId : undefined;
  const blog = post.liveBlog;
  return blog && typeof blog === "object" && "branding" in blog && blog.branding === "nj-decides-2026" ? "nj-decides-2026" : undefined;
}
