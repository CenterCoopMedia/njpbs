import type { RichTextNode } from "../../../packages/content-core/src/content-model";
import { orderedLiveBlogUpdates, type LiveBlogData } from "../../../packages/content-core/src/live-blog";
import type { JsonLd } from "./structured-data";

function plainText(node: RichTextNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak" || node.type === "horizontalRule") return "\n";
  return (node.content ?? []).map(plainText).join(["paragraph", "heading"].includes(node.type) ? "" : "\n");
}

/** Uses only the public snapshot already rendered by the Post route. */
export function liveBlogPostingJsonLd(input: {
  postId: string; title: string; canonicalPath: string; datePublished: string | null;
  liveBlog: LiveBlogData; site: string | URL;
}): JsonLd | null {
  if (input.liveBlog.coverageState === "ended") return null;
  const url = new URL(input.canonicalPath, input.site).href;
  const updates = orderedLiveBlogUpdates(input.liveBlog);
  const first = updates.at(-1);
  const modified = updates.reduce<string | undefined>((latest, entry) => !latest || Date.parse(entry.updatedAt) > Date.parse(latest) ? entry.updatedAt : latest, undefined);
  return {
    "@context": "https://schema.org",
    "@type": "LiveBlogPosting",
    headline: input.title, url,
    ...(input.datePublished ? { datePublished: input.datePublished } : {}),
    ...(modified ? { dateModified: modified } : {}),
    ...(first ? { coverageStartTime: first.publishedAt } : {}),
    liveBlogUpdate: updates.filter(entry => entry.withdrawal === undefined).map(entry => ({
      "@type": "BlogPosting",
      "@id": `${url}#live-blog-${input.postId.length}-${input.postId}-entry-${entry.id.length}-${entry.id}`,
      headline: entry.headline, datePublished: entry.publishedAt, dateModified: entry.updatedAt,
      articleBody: plainText(entry.body).trim(),
    })),
  };
}
