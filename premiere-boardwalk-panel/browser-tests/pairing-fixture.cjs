"use strict";
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const pairing = { deviceCode: "D".repeat(43), userCode: "KXQR-7M2P", expiresIn: 600, interval: 5,
  verificationUriComplete: "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P" };

// Browser-only platform substitutions. They do not establish native UXP behavior.
async function openPairingPanel({ width = 400, panelRoot = path.resolve(__dirname, "../dist"), response = pairing } = {}) {
  const assets = new Map([
    ["/index.html", "text/html"], ["/index.js", "text/javascript"], ["/index.css", "text/css"],
    ["/brand/tokens.css", "text/css"], ["/brand/njpbs-horizontal-white.svg", "image/svg+xml"],
  ]);
  const server = createServer(async (req, res) => {
    const file = new URL(req.url, "http://127.0.0.1").pathname;
    if (!assets.has(file)) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(path.join(panelRoot, file));
      res.writeHead(200, { "content-type": assets.get(file) }).end(body);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  const close = async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); };
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.hostname === "127.0.0.1" || url.protocol === "data:" ? route.continue() : route.abort();
    });
    await page.addInitScript(pair => {
      window.openedUrls = [];
      window.copiedContent = [];
      window.copyFailure = false;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        setContent: async content => {
          if (window.copyFailure) throw new Error("Clipboard unavailable");
          window.copiedContent.push(content);
        },
      } });
      window.fetch = async input => {
        const endpoint = String(input).split("/").pop();
        if (endpoint === "cmsStartPremierePairing") return Response.json(pair);
        if (endpoint === "cmsPollPremierePairing") return Response.json({ status: "pending", interval: 5 });
        throw new Error(`Unexpected fixture request: ${endpoint}`);
      };
      window.require = name => {
        if (name === "uxp") return { host: { version: "26.5.2" },
          entrypoints: { setup() {} }, shell: { openExternal: async url => { window.openedUrls.push(url); } },
          storage: { secureStorage: { getItem: async () => { throw new Error("No session"); } }, localFileSystem: {} } };
        if (name === "premierepro") return { Project: { getActiveProject: async () => ({ name: "Shore erosion feature" }) } };
        if (name === "os") return { platform: () => "win32" };
        if (name === "fs") return {};
        throw new Error(`Unexpected platform module: ${name}`);
      };
    }, response);
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.getByRole("button", { name: "Connect Boardwalk", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Open Boardwalk", exact: true }).waitFor();
    await page.waitForFunction(() => window.openedUrls.length === 1);
    return { page, errors, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { openPairingPanel, pairing };
