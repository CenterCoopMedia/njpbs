// Local review file only: no Astro route, credentials, network or CMS writes.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";
import { LIVE_BLOG_SPECIMEN } from "../tests/fixtures/live-blog";

const tokens = await readFile(new URL("../src/styles/design-tokens.css", import.meta.url), "utf8");
const styles = await readFile(new URL("../../packages/content-core/src/live-blog.css", import.meta.url), "utf8");
const directory = await mkdtemp(join(tmpdir(), "njpbs-live-blog-"));
const html = renderLiveBlog(LIVE_BLOG_SPECIMEN, { id: "specimen", asOf: "2026-11-04T04:00:00Z" });
await writeFile(join(directory, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live blog review specimen</title><style>${tokens}\n${styles}\n*{box-sizing:border-box}body{margin:0;background:var(--color-surface-page);color:var(--color-text-on-surface);font-family:var(--font-sans);font-size:1.125rem;line-height:1.6}main{max-width:76rem;margin:auto;padding:clamp(1rem,4vw,3rem)}h1{max-width:none;font-size:clamp(2rem,5vw,3.5rem);line-height:1.15}h2{font-size:2rem}h3{font-size:1.4rem;line-height:1.3}</style></head><body><main><h1>Live blog review specimen</h1><p>Synthetic coverage for local design review.</p>${html}</main></body></html>`);
console.log(directory);
