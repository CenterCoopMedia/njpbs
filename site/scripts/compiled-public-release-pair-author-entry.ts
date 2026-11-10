import { authorPublicPath } from "../../packages/content-core/src/author-profiles";
import { createApp } from "astro/app/entrypoint";
import { derivePublicReleasePairAuthors, PairAuthorError, type PairAuthorContext } from "./public-release-pair-author";
import { assertPublishedResources } from "../src/lib/published-resource-check";

declare const __CMS_RENDERER_SHA__: string;
const app = createApp({ streaming: false });

/** Private replay entry only: NEW projectors and the existing author template
 * consume raw verified H. There is no invented public author reader response. */
export async function* renderPublicReleasePairAuthors(context: PairAuthorContext) {
  if (context.pair.commitSha !== __CMS_RENDERER_SHA__) throw new PairAuthorError("author-owner-mismatch");
  const projection = await derivePublicReleasePairAuthors(context);
  for (const route of projection.routes) {
    const path = route.path;
    let body = new Uint8Array();
    if (route.status === 200) {
      const response = await app.render(new Request(new URL(path, "https://njpbs.org")), { locals: { cmsRender: {
        content: projection.content(path), homeSources: { schemaVersion: 1, publication: null, heroCatalog: [],
          pbs: { source: "manual", checkedAt: null, featured: [], more: [] }, spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } },
      } } });
      if (response.status !== 200) throw new PairAuthorError("author-input-mismatch");
      const html = await response.text();
      assertPublishedResources(html, path, context.pair.environment === "development" ? "https://dev-public.example.org" : "https://njpbs.org");
      body = new TextEncoder().encode(html);
    }
    yield { ...route, body };
  }
}

/** The full static artifact retains real retired-slug HTML, independently of
 * the public dynamic alias response. Reproject H before rendering the stub. */
export async function renderPublicReleasePairStaticAuthorAlias(context: PairAuthorContext, path: string): Promise<Uint8Array> {
  if (context.pair.commitSha !== __CMS_RENDERER_SHA__) throw new PairAuthorError("author-owner-mismatch");
  const projection = await derivePublicReleasePairAuthors(context), route = projection.routes.find(route => route.path === path);
  if (!route || route.status !== 308 || !route.location) throw new PairAuthorError("author-owner-mismatch");
  const content = projection.content(route.location), author = content.authors.find(author => author.path === route.location);
  if (!author || !author.previousSlugs.map(authorPublicPath).includes(path)) throw new PairAuthorError("author-owner-mismatch");
  const response = await app.render(new Request(new URL(path, "https://njpbs.org")), { locals: { cmsRender: {
    content, homeSources: { schemaVersion: 1, publication: null, heroCatalog: [],
      pbs: { source: "manual", checkedAt: null, featured: [], more: [] }, spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } },
    staticRedirect: { from: path, to: route.location },
  } } });
  if (response.status !== 200) throw new PairAuthorError("author-input-mismatch");
  const html = await response.text();
  assertPublishedResources(html, path, context.pair.environment === "development" ? "https://dev-public.example.org" : "https://njpbs.org");
  return new TextEncoder().encode(html);
}
