import { contentLink } from "../../packages/content-core/src/content-link.ts";
import type { ContentLinkSearchRecord } from "../src/lib/content-link-search";
import { performance } from "node:perf_hooks";
import { createIndex, close } from "pagefind";
import { parse } from "parse5";
import views from "../../functions/lib/public-release-pair-view.js";
type HtmlInput = { path: string; bytes: Uint8Array };
let running = false;
function refuse(): never { throw new Error("Frozen Pagefind projection is unavailable"); }
const mime: Record<string, string> = { js: "application/javascript; charset=utf-8", json: "application/json; charset=utf-8", css: "text/css; charset=utf-8",
  wasm: "application/wasm", svg: "image/svg+xml", pf_filter: "application/octet-stream", pf_meta: "application/octet-stream", pf_index: "application/octet-stream",
  pf_fragment: "application/octet-stream", pagefind: "application/octet-stream" };
function tagged(source: string) {
  const document = parse(source); let body = false, noindex = false;
  const visit = (node: typeof document | any) => {
    if (Array.isArray(node.attrs)) {
      if (node.attrs.some((attr: { name: string }) => attr.name === "data-pagefind-body")) body = true;
      if (node.tagName === "meta" && node.attrs.find((attr: { name: string }) => attr.name === "name")?.value?.toLowerCase() === "robots" &&
          /\bnoindex\b/i.test(node.attrs.find((attr: { name: string }) => attr.name === "content")?.value ?? "")) noindex = true;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document); return body && !noindex;
}
/** The exact pinned native engine runs within the existing network-disabled
 * sandbox. All HTML is NEW rendered or sealed static fallback, never latest. */
export async function buildPublicReleasePairPagefind(inputs: AsyncIterable<HtmlInput>, nativePath: string, contentLinks: readonly ContentLinkSearchRecord[] = []) {
  if (running || !nativePath.startsWith("/")) refuse(); running = true;
  const previous = process.env.PAGEFIND_EXTENDED_BINARY_PATH;
  process.env.PAGEFIND_EXTENDED_BINARY_PATH = nativePath;
  const started = performance.now(); let htmlCount = 0, indexedCount = 0, htmlBytes = 0, previousPath = "";
  try {
    const created = await createIndex(); if (created.errors.length || !created.index) refuse();
    for await (const input of inputs) {
      if (views.comparePrivatePairArtifactPaths(input.path, previousPath) <= 0 || ++htmlCount > views.VIEW_OUTPUT_LIMIT || input.bytes.length < 1 || input.bytes.length > views.BODY_BYTES_LIMIT) refuse();
      previousPath = input.path; htmlBytes += input.bytes.length;
      if (htmlBytes > views.VIEW_TOTAL_BYTES_LIMIT) refuse();
      const source = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
      if (!tagged(source)) continue;
      const reply = await created.index.addHTMLFile({ url: input.path, content: source }); if (reply.errors.length) refuse(); indexedCount++;
    }
    for (const record of contentLinks) {
      const link = contentLink(record, record.path);
      const reply = await created.index.addCustomRecord({ url: record.path, content: `${record.title} ${record.text}`, language: "en",
        meta: { title: record.title, contentLinkUrl: link.href, contentLinkNewTab: String(link.newTab) } });
      if (reply.errors.length) refuse();
      indexedCount++;
    }
    if (!indexedCount) refuse();
    const result = await created.index.getFiles(); if (result.errors.length || !result.files?.length || result.files.length > views.VIEW_OUTPUT_LIMIT) refuse();
    let outputBytes = 0;
    const files = result.files.map(file => {
      const path = `/pagefind/${file.path}`, contentType = mime[file.path.split(".").at(-1) ?? ""];
      if (!views.isPrivatePairArtifactPath(path) || !contentType || file.content.length > views.BODY_BYTES_LIMIT) refuse();
      outputBytes += file.content.length;
      if (outputBytes > views.VIEW_TOTAL_BYTES_LIMIT) refuse();
      return { path, mime: contentType, bytes: new Uint8Array(file.content) };
    }).sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path));
    if (!files.some(file => file.path === "/pagefind/pagefind.js") || !files.some(file => file.path === "/pagefind/pagefind-entry.json") ||
        files.some((file, index) => index > 0 && file.path === files[index - 1].path)) refuse();
    return { files, metrics: { engineVersion: "1.5.0" as const, htmlCount, indexedCount, htmlBytes, outputCount: files.length, outputBytes, elapsedMs: performance.now() - started } };
  } finally {
    try { await close(); }
    finally {
      if (previous === undefined) delete process.env.PAGEFIND_EXTENDED_BINARY_PATH; else process.env.PAGEFIND_EXTENDED_BINARY_PATH = previous;
      running = false;
    }
  }
}
