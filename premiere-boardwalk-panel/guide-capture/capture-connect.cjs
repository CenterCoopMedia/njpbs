"use strict";
// Staff guide screenshots of the Boardwalk Premiere connection page.
//
// Renders the real PremiereConnectPanel through the Admin dev gallery's premiere-connect
// specimen. The specimen answers the approval endpoint in the browser; this script also
// refuses every non-local request.
//
// Usage: npm run dev -w njpbs-admin   (or npx vite in admin/)
//        node premiere-boardwalk-panel/guide-capture/capture-connect.cjs [admin-origin] [output-folder]
const path = require("node:path");
const { writeFile, mkdir } = require("node:fs/promises");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const origin = process.argv[2] || "http://localhost:5173";
const output = path.resolve(process.argv[3] || process.env.GUIDE_CAPTURE_OUTPUT || "./guide-capture-output");
const VIEWPORT = { width: 900, height: 900 };
const FROZEN_NOW = Date.parse("2026-08-20T15:00:00-04:00");

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
  const shots = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce", locale: "en-US",
      timezoneId: "America/New_York" });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      return ["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol === "data:"
        ? route.continue() : route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(now => {
      const RealDate = Date;
      class FrozenDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(now); else super(...args); }
        static now() { return now; }
      }
      globalThis.Date = FrozenDate;
    }, FROZEN_NOW);
    await page.goto(`${origin}/gallery.html?embed=premiere-connect&presentation=text&guide=1&code=KXQR-7M2P`);
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Connect Premiere to Boardwalk" }) }).first();

    async function shot(file, state) {
      await page.getByRole("heading", { name: "Connect Premiere to Boardwalk" }).hover();
      await page.evaluate(() => document.activeElement?.blur());
      await page.evaluate(() => document.fonts.ready);
      const png = await panel.screenshot({ animations: "disabled", caret: "hide" });
      const encoded = await page.evaluate(async source => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return canvas.toDataURL("image/webp", 0.88);
      }, `data:image/png;base64,${png.toString("base64")}`);
      const body = Buffer.from(encoded.split(",")[1], "base64");
      await writeFile(path.join(output, file), body);
      shots.push({ file, state, bytes: body.length });
    }

    const code = page.getByLabel("Connection code");
    if (await code.inputValue() !== "KXQR-7M2P") throw new Error("The query code was not prefilled");
    if (new URL(page.url()).searchParams.has("code")) throw new Error("The query code was not stripped");
    await shot("premiere-connect-code.webp", "Connection code prefilled and removed from the URL; Review connection enabled.");
    await page.getByRole("button", { name: "Review connection" }).click();
    await page.getByRole("button", { name: "Approve this computer" }).waitFor();
    await shot("premiere-connect-review.webp", "Request review: Premiere Pro 26.5.2, the code, access and diagnostics notes, Approve, Deny and Use a different code.");
    await page.getByRole("button", { name: "Approve this computer" }).click();
    await page.getByText("Connection approved. Return to Premiere to open your library.").waitFor();
    await shot("premiere-connect-approved.webp", "Approval confirmation with the empty code field.");
    await code.fill("WXYZ-2345");
    await page.getByRole("button", { name: "Review connection" }).click();
    await page.getByText("This sign-in code expired. Start again in Premiere.").waitFor();
    await shot("premiere-connect-expired.webp", "Expired code error above the code field.");
    if (errors.length) throw new Error(errors.join("\n"));
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify({ viewport: VIEWPORT, output: path.relative(root, output), shots }, null, 2)}\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
