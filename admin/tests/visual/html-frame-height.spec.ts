import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderHtmlBlock } from "../../../packages/content-core/src/content-render";

declare global {
  interface Window {
    heightPosts: { index: number; height: number }[];
    htmlFrameControls: typeof import("../../../packages/content-core/src/html-frame-controls");
  }
}

let server: Server;
let url: string;

test.beforeAll(async () => {
  const controls = await build({
    entryPoints: [fileURLToPath(new URL("../../../packages/content-core/src/html-frame-controls.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", globalName: "htmlFrameControls",
  });
  const styles = await readFile(new URL("../../../packages/content-core/src/component-blocks.css", import.meta.url), "utf8");
  const frames = [0, 100, 200].map(extra => renderHtmlBlock({
    title: `Chart ${extra}`,
    html: `<style>.chart{height:${604 + extra}px}@media(max-width:600px){.chart{height:${812 + extra}px}}</style><div class="chart">Chart</div>`,
  })).join("");
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${styles}</style>
      <script>window.heightPosts=[];addEventListener("message",event=>{const height=event.data?.njpbsHtmlFrameHeight;if(typeof height==="number")heightPosts.push({index:[...document.querySelectorAll("iframe[data-html-frame]")].findIndex(frame=>frame.contentWindow===event.source),height})});</script>
      </head><body>${frames}<script>${controls.outputFiles[0].text}</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  url = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

for (const width of [1280, 390]) {
  test(`fits settled frames when the parent listener installs late at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const heights = [0, 100, 200].map(extra => (width === 390 ? 812 : 604) + extra);
    await page.goto(url);
    const frames = page.locator("iframe[data-html-frame]");
    // The real child scripts have already posted their final content sizes. The
    // parent listener deliberately has not been installed, reproducing #5004.
    await expect.poll(() => page.evaluate(expected => expected.every((height, index) =>
      window.heightPosts.some(post => post.index === index && post.height === height)), heights)).toBe(true);
    expect(await frames.evaluateAll(items => items.map(frame => frame.getBoundingClientRect().height))).toEqual([152, 152, 152]);
    await page.evaluate(() => window.htmlFrameControls.installHtmlFrameControls(window));
    await expect.poll(() => frames.evaluateAll(items => items.map(frame => frame.getBoundingClientRect().height))).toEqual(heights);
    for (let index = 0; index < heights.length; index++) {
      expect(await frames.nth(index).contentFrame().locator("html").evaluate(element => element.getBoundingClientRect().height)).toBe(heights[index]);
    }
  });
}
