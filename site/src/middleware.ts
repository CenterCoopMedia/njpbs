import { defineMiddleware } from "astro:middleware";
import { getCollection } from "astro:content";
import { renderContentLinks } from "./lib/content-link-render";

/** Every public HTML renderer, including sealed replay, passes this boundary. */
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const content = context.locals.cmsRender?.content;
  const entries = content ? [...content.posts, ...content.pages, ...(content.contentLinks ?? [])]
    : [...(await getCollection("cmsPosts")).map(entry => entry.data), ...(await getCollection("cmsPages")).map(entry => entry.data)];
  const html = renderContentLinks(await response.text(), entries, context.url.href,
    content?.kind === "private-preview" ? undefined : context.url.pathname);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
});
