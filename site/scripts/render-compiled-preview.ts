import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCmsPreviewInput } from "../src/lib/cms-preview-input.ts";
import { projectCmsPreviewContent } from "../src/lib/cms-preview-content.ts";
import { verifyCompiledRenderer } from "./compiled-renderer-release.mjs";

/** Invoked only inside the existing credential-free, network-free sandbox. */
const request = resolveCmsPreviewInput();
if (!request) throw new Error("Compiled preview requires frozen input");
const releaseDirectory = fileURLToPath(new URL("../.compiled-renderer", import.meta.url));
const release = await verifyCompiledRenderer(releaseDirectory, request.rendererSha);
const content = projectCmsPreviewContent(await readFile(request.path), request, new Date());
const renderer = await import(pathToFileURL(path.join(releaseDirectory, "server/entry.mjs")).href);
if (renderer.rendererSha !== request.rendererSha) throw new Error("Compiled template source does not match the request");
const curatedHome = content.target.documentId === "home" && content.pages.some(page => page.pageId === "home" &&
  page.homeCompositionVersion === 2 && page.blocks.some(block => block.type === "content_shelf"));
if (curatedHome && !content.homeSources?.editorial) throw new Error("Home preview requires the current published source catalog");
const html = await renderer.render({ content, homeSources: content.homeSources ?? release.homeSources });
if (content.target.expiresAtMs <= Date.now()) throw new Error("Compiled preview expired during rendering");
const output = "/preview/dist";
await cp(path.join(releaseDirectory, "client"), output, { recursive: true });
const pageDirectory = path.join(output, content.target.pagePath.slice(1));
await mkdir(pageDirectory, { recursive: true, mode: 0o700 });
await writeFile(path.join(pageDirectory, "index.html"), html, { mode: 0o600 });
console.log(JSON.stringify({ event: "compiled-preview-rendered", rendererSha: request.rendererSha,
  queueId: request.queueId, sourceVersion: content.target.sourceVersion }));
