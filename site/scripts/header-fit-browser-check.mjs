// Run against a local full build: xvfb-run -a node scripts/header-fit-browser-check.mjs
// Serve dist with `npm run preview -- --host 127.0.0.1 --port 4322` first.
// Set HEADER_FIT_SCREENS to a directory to save a screenshot of each case.
// Set HEADLESS=1 to hide the browser. Run as a user that supports sandboxing.
//
// Staff can publish up to 12 header links. jsdom cannot measure layout, so this
// check adds links to the served page and measures the real header. When the
// links do not fit on one row, the header must use the menu button, and the
// page must not scroll sideways.
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4322";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Use a local build.");
const screens = process.env.HEADER_FIT_SCREENS;
const EXTRA_LABELS = ["Radio", "Education", "Events", "Newsroom", "Careers", "Contact us"];
const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADLESS === "1", chromiumSandbox: true });

// Serve the page with `total` header links. The added links copy the markup of
// the first link, so they carry the same scoped style attributes.
function withHeaderLinks(html, total) {
  const nav = html.indexOf('id="primary-nav"');
  const util = html.indexOf("primary__util", nav);
  assert(nav > 0 && util > nav, "The page has the primary navigation.");
  const insertAt = html.lastIndexOf("<li", util);
  const current = (html.slice(nav, insertAt).match(/<li\b/g) ?? []).length;
  assert(total >= current, `The page already has ${current} header links.`);
  const first = html.indexOf("<li", nav);
  const sample = html
    .slice(first, html.indexOf("</li>", first) + 5)
    .replace(/ aria-current="page"/g, "")
    .replace(/\bclass="active"/g, 'class=""');
  let extra = "";
  for (let index = 0; index < total - current; index += 1) {
    extra += sample
      .replace(/href="[^"]*"/, `href="/extra-${index + 1}/"`)
      .replace(/(<a\b[^>]*>)[\s\S]*?(<\/a>)/, `$1${EXTRA_LABELS[index]}$2`);
  }
  return html.slice(0, insertAt) + extra + html.slice(insertAt);
}

async function open(total, { width, javaScriptEnabled = true, longLabel = false }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (total !== undefined) {
    await page.route(`${base}/about/`, async (route) => {
      const response = await route.fetch();
      let body = withHeaderLinks(await response.text(), total);
      if (longLabel) {
        body = body.replace(/(<a\b[^>]*href="\/extra-1\/"[^>]*>)[\s\S]*?(<\/a>)/, `$1${"W".repeat(80)}$2`);
      }
      await route.fulfill({ response, body });
    });
  }
  await page.goto(`${base}/about/`);
  await page.evaluate(() => document.fonts?.ready);
  // A no-script page has no fit callback, and it cannot run animation frames.
  if (javaScriptEnabled) await settleHeader(page);
  return { context, page, errors };
}

// fit() runs in requestAnimationFrame after resize/font events. Wait for that
// work and its paint before reading state, rather than waiting a fixed time.
async function settleHeader(page) {
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
}

// The documented contract is whether the complete inline row fits, regardless
// of link count. Temporarily expose that input layout, then restore the state
// produced by the script. Bounds are independent of its collapsed flag.
async function inlineHeaderFits(page) {
  return page.locator(".site-head").evaluate((head) => {
    const collapsed = head.hasAttribute("data-nav-collapsed");
    head.removeAttribute("data-nav-collapsed");
    try {
      const inner = head.querySelector(".head-inner");
      const style = getComputedStyle(inner);
      const rightEdge = inner.getBoundingClientRect().right - parseFloat(style.paddingRight);
      return [...inner.children].every((child) =>
        child.getBoundingClientRect().right <= rightEdge + 1,
      );
    } finally {
      head.toggleAttribute("data-nav-collapsed", collapsed);
    }
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const head = document.querySelector(".site-head");
    const inner = head.querySelector(".head-inner");
    const toggle = head.querySelector(".nav-toggle");
    const links = [...head.querySelectorAll("#primary-nav > ul > li:not(.primary__util) a")];
    const visible = links.filter((link) => link.getClientRects().length > 0);
    return {
      links: links.length,
      collapsed: head.hasAttribute("data-nav-collapsed"),
      menuButton: getComputedStyle(toggle).display !== "none",
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      headerOverflow: inner.scrollWidth - inner.clientWidth,
      visibleLinks: visible.length,
      rows: new Set(visible.map((link) => Math.round(link.getBoundingClientRect().top))).size,
    };
  });
}

async function shot(page, name) {
  if (!screens) return;
  await page.screenshot({ path: join(screens, `${name}.png`), clip: { x: 0, y: 0, width: page.viewportSize().width, height: 520 } });
}

const report = [];
try {
  // Page text must be hidden after scrolling, including without script or when
  // the reader requests reduced transparency. Returning to the top restores
  // the default appearance.
  for (const javaScriptEnabled of [true, false]) {
    const { context, page } = await open(undefined, { width: 1280, javaScriptEnabled });
    const header = page.locator(".site-head");
    const background = () => header.evaluate((head) => getComputedStyle(head).backgroundColor);
    const opaque = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--color-surface-page)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    const initial = await background();
    if (javaScriptEnabled) assert.notEqual(initial, opaque);
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForFunction((color) => getComputedStyle(document.querySelector(".site-head")).backgroundColor === color, opaque);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction((color) => getComputedStyle(document.querySelector(".site-head")).backgroundColor === color, initial);
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-saver", "");
      window.scrollTo(0, 300);
    });
    await page.waitForFunction((color) => getComputedStyle(document.querySelector(".site-head")).backgroundColor === color, opaque);
    await page.evaluate(() => {
      document.documentElement.removeAttribute("data-saver");
      window.scrollTo(0, 0);
    });
    await page.waitForFunction((color) => getComputedStyle(document.querySelector(".site-head")).backgroundColor === color, initial);
    const media = await context.newCDPSession(page);
    await media.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches), true);
    assert.equal(await background(), opaque);
    await page.evaluate(() => document.documentElement.setAttribute("data-saver", ""));
    assert.equal(await background(), opaque);
    report.push({ case: `opaque scrolled header, scripts ${javaScriptEnabled ? "on" : "off"}`, background: opaque });
    await context.close();
  }

  // Labels and fonts determine fit. Exercise every supported fixture count,
  // keeping the full row when it fits and the existing menu when it does not.
  for (const total of [undefined, 8, 9, 10, 11, 12]) {
    const { context, page, errors } = await open(total, { width: 1280 });
    const fits = await inlineHeaderFits(page);
    const result = await measure(page);
    report.push({ case: `${total ?? "default"} links, 1280`, fits, ...result });
    if (total !== undefined) assert.equal(result.links, total);
    if (fits) {
      assert.equal(result.collapsed, false);
      assert.equal(result.menuButton, false);
      assert.equal(result.visibleLinks, result.links);
      assert.equal(result.rows, 1);
      assert(result.pageOverflow <= 0 && result.headerOverflow <= 1, JSON.stringify(result));
      assert.deepEqual(errors, []);
      await shot(page, `public-fit-${total ?? "default"}-links-1280-header`);
      await context.close();
      continue;
    }
    assert.equal(result.collapsed, true);
    assert.equal(result.menuButton, true);
    assert.equal(result.visibleLinks, 0);
    assert(result.pageOverflow <= 0 && result.headerOverflow <= 1, JSON.stringify(result));
    await shot(page, `public-fit-${total}-links-1280-header`);
    const menu = page.getByRole("button", { name: "Menu" });
    await menu.click();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    const opened = await measure(page);
    assert.equal(opened.visibleLinks, total);
    assert(opened.pageOverflow <= 0, JSON.stringify(opened));
    if (total === 12) await shot(page, "public-fit-12-links-1280-menu-open");
    // A fit check while the menu is open must keep the panel and the focus.
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await settleHeader(page);
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    assert.equal(await menu.evaluate((button) => button === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await settleHeader(page);
    assert.equal(await menu.evaluate((button) => button === document.activeElement), true);
    // When the links fit again, the next resize check restores the inline row.
    await page.evaluate(() => {
      document.querySelectorAll('#primary-nav a[href^="/extra-"]').forEach((link) => link.closest("li").remove());
      window.dispatchEvent(new Event("resize"));
    });
    await settleHeader(page);
    const restored = await measure(page);
    assert.equal(restored.collapsed, false);
    assert.equal(restored.menuButton, false);
    assert.equal(restored.rows, 1);
    if (total === 12) {
      // A header link has focus when the row collapses: focus moves to the
      // menu button instead of the page.
      await page.evaluate(() => {
        const list = document.querySelector("#primary-nav > ul");
        const util = list.querySelector(":scope > .primary__util");
        for (let i = 0; i < 6; i += 1) {
          const item = document.createElement("li");
          const link = document.createElement("a");
          link.href = `/extra-again-${i}/`;
          link.textContent = `Extra section ${i}`;
          item.append(link);
          list.insertBefore(item, util);
        }
      });
      await page.locator("#primary-nav > ul > li:not(.primary__util) a").first().focus();
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await settleHeader(page);
      const recollapsed = await measure(page);
      assert.equal(recollapsed.collapsed, true);
      assert.equal(await menu.evaluate((button) => button === document.activeElement), true);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  // The phone layout keeps its menu button for the default and 12-link headers.
  for (const total of [undefined, 12]) {
    const { context, page, errors } = await open(total, { width: 390 });
    const result = await measure(page);
    report.push({ case: `${total ?? "default"} links, 390`, ...result });
    assert.equal(result.collapsed, false);
    assert.equal(result.menuButton, true);
    assert.equal(result.visibleLinks, 0);
    assert(result.pageOverflow <= 0, JSON.stringify(result));
    await page.getByRole("button", { name: "Menu" }).click();
    assert.equal((await measure(page)).visibleLinks, result.links);
    await shot(page, `public-fit-${total ?? "default"}-links-390-menu-open`);
    if (total === 12) {
      // Widening with the phone menu open collapses the desktop row and keeps
      // the open panel, its button and the keyboard focus.
      const phoneMenu = page.getByRole("button", { name: "Menu" });
      await phoneMenu.focus();
      await page.setViewportSize({ width: 1280, height: 900 });
      await settleHeader(page);
      const widened = await measure(page);
      assert.equal(widened.collapsed, true);
      assert.equal(widened.menuButton, true);
      assert.equal(widened.visibleLinks, total);
      assert(widened.pageOverflow <= 0, JSON.stringify(widened));
      assert.equal(await phoneMenu.evaluate((button) => button === document.activeElement), true);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  // An unbroken 80-byte label must wrap inside both menu panels.
  for (const width of [390, 1280]) {
    const { context, page, errors } = await open(12, { width, longLabel: true });
    const initial = await measure(page);
    assert.equal(initial.collapsed, width === 1280);
    await page.getByRole("button", { name: "Menu" }).click();
    const label = page.locator('#primary-nav a[href="/extra-1/"]');
    assert.equal(await label.textContent(), "W".repeat(80));
    const result = await measure(page);
    const wrapping = await label.evaluate((link) => ({
      whiteSpace: getComputedStyle(link).whiteSpace,
      overflowWrap: getComputedStyle(link).overflowWrap,
      linkOverflow: link.scrollWidth - link.clientWidth,
      menuOverflow: link.closest("nav").scrollWidth - link.closest("nav").clientWidth,
    }));
    report.push({ case: `80-character label, ${width}`, ...result, ...wrapping });
    assert.equal(result.visibleLinks, 12);
    assert.equal(wrapping.whiteSpace, "normal");
    assert.equal(wrapping.overflowWrap, "anywhere");
    assert(result.pageOverflow <= 0 && wrapping.linkOverflow <= 1 && wrapping.menuOverflow <= 1, JSON.stringify({ result, wrapping }));
    assert.deepEqual(errors, []);
    await shot(page, `public-fit-long-label-${width}-menu-open`);
    await context.close();
  }

  // Without scripts, a 12-link desktop header wraps instead of overflowing.
  for (const total of [undefined, 12]) {
    const { context, page } = await open(total, { width: 1280, javaScriptEnabled: false });
    const result = await measure(page);
    report.push({ case: `${total ?? "default"} links, 1280, no JS`, ...result });
    assert.equal(result.menuButton, false);
    assert.equal(result.visibleLinks, result.links);
    assert(result.pageOverflow <= 0 && result.headerOverflow <= 1, JSON.stringify(result));
    if (total === undefined) assert.equal(result.rows, 1);
    await shot(page, `public-fit-${total ?? "default"}-links-1280-no-js`);
    await context.close();
  }
} finally {
  console.table(report);
  await browser.close();
}
