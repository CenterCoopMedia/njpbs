import { createApp } from "astro/app/entrypoint";
import type { CmsRenderContext } from "../src/lib/cms-render-context";

declare const __CMS_RENDERER_SHA__: string;
export const rendererSha = __CMS_RENDERER_SHA__;

const app = createApp({ streaming: false });

/** No listening socket. Only the sandbox processor supplies validated locals. */
export async function render(context: CmsRenderContext): Promise<string> {
  const { content } = context;
  if (content.kind !== "private-preview" || content.target.rendererSha !== rendererSha ||
    !/^\/(?:[^?#\\\s]*\/)?$/.test(content.target.pagePath) || content.target.pagePath.startsWith("//") ||
    content.target.expiresAtMs <= Date.now()) {
    throw new Error("Compiled renderer requires an exact private content target");
  }
  const request = new Request(new URL(context.content.target.pagePath, "https://njpbs.org"));
  if (new URL(request.url).pathname !== content.target.pagePath) throw new Error("Compiled preview route is not canonical");
  const response = await app.render(request, {
    locals: { cmsRender: { content, homeSources: structuredClone(context.homeSources) } },
  });
  if (response.status !== 200) throw new Error("Compiled preview rendering failed");
  const html = await response.text();
  if (content.target.expiresAtMs <= Date.now()) throw new Error("Compiled preview expired during rendering");
  return html;
}
