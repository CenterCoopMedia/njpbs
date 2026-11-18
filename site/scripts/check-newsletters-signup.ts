import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { chromium } from "playwright";
import { ANALYTICS_CONSENT_DENIED, initAnalyticsConsent, readAnalyticsConsent } from "../src/lib/analytics-consent";
import { WISEPOPS_CONSENT_SNIPPET } from "../src/lib/analytics-consent-head";

async function checkSignupInteraction(markup: string) {
  const css = await readFile(new URL("../../packages/content-core/src/component-blocks.css", import.meta.url), "utf8");
  const client = await build({ stdin: {
    resolveDir: fileURLToPath(new URL("../src/lib/", import.meta.url)),
    contents: 'import { initNewsletterSignupEmbed } from "./newsletter-signup-embed"; initNewsletterSignupEmbed(document);',
  }, bundle: true, write: false });
  const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route("https://wisepops.net/**", route => route.abort());
    const prepare = async () => {
      await page.setContent(`<style>${css}</style>${markup}<p id="after-signup">Next section</p><script>${WISEPOPS_CONSENT_SNIPPET}</script>`);
      await page.addScriptTag({ content: client.outputFiles[0].text });
    };
    const button = page.getByRole("button", { name: "Show sign-up form" });
    const status = page.getByRole("status");
    const target = page.getByRole("region", { name: "Newsletter sign-up form" });
    const after = page.locator("#after-signup");
    const loader = page.locator("script[data-njpbs-wisepops]");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 850 });
      await prepare();
      const initialOffset = (await after.boundingBox())!.y;
      assert.equal(await loader.count(), 0, "No vendor request before activation");
      await button.press("Enter");
      assert.equal(await loader.count(), 1, "Keyboard activation requests the same loader");
      assert.equal(await status.textContent(), "Loading the sign-up form…");
      assert(await status.evaluate(element => element === document.activeElement));
      await target.evaluate(element => {
        element.innerHTML = '<form aria-label="Mock form"><label>Email <input type="email"></label></form>';
      });
      await page.getByText("Loading the sign-up form…").waitFor({ state: "hidden" });
      assert(await target.evaluate(element => element === document.activeElement));
      assert(await page.getByRole("form", { name: "Mock form" }).isVisible());
      assert.equal((await after.boundingBox())!.y, initialOffset, `Signup space is stable at ${width}px`);
    }
    await page.clock.install();
    await prepare();
    await button.click();
    await page.clock.fastForward(5000);
    assert.match(await status.textContent() ?? "", /could not load/);
    assert(await status.evaluate(element => element === document.activeElement));
  } finally {
    await browser.close();
  }
}

/** Exercise emitted Page HTML with the real bootstrap and consent controls.
 * Vendor requests stay disabled; campaign content is supplied at that boundary.
 */
export async function checkNewslettersSignup(html: string): Promise<void> {
  const windows: Window[] = [];
  function openPage(cookie?: string, gpc = false) {
    const dom = new Window({ url: "https://njpbs.org/newsletters/", settings: {
      disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true, disableIframePageLoading: true,
    } });
    windows.push(dom);
    const document = dom.document;
    document.write(html);
    // These parity fixtures use the development renderer, where analytics is
    // intentionally absent. Mount the production consent boundary explicitly.
    document.body.insertAdjacentHTML("beforeend", `
      <button data-consent-open>Privacy choices</button>
      <aside data-analytics-consent data-measurement-id="G-TEST123" hidden>
        <div data-consent-choice><button data-consent-grant>Allow</button><button data-consent-deny>Deny</button></div>
        <div data-consent-gpc hidden><button data-consent-close>Close</button></div>
      </aside>`);
    if (cookie) document.cookie = `njpbs-consent=${encodeURIComponent(cookie)}; Path=/; Secure`;
    Object.defineProperty(dom.navigator, "globalPrivacyControl", { value: gpc });
    let reloads = 0;
    const windowRef = {
      document, navigator: dom.navigator,
      location: { hostname: "njpbs.org", pathname: "/newsletters/", reload: () => { reloads++; } },
      addEventListener: dom.addEventListener.bind(dom),
    } as unknown as Parameters<typeof initAnalyticsConsent>[1];
    runInNewContext(WISEPOPS_CONSENT_SNIPPET, { window: windowRef, document, navigator: dom.navigator });
    const root = document.querySelector("[data-analytics-consent]");
    assert(root, "Newsletter Page retains the consent controls");
    initAnalyticsConsent(root as unknown as HTMLElement, windowRef);
    const anchor = document.querySelector("#njpbssignup");
    assert(anchor, "Signup anchor exists before consent");
    assert.equal(document.querySelectorAll("#njpbssignup").length, 1);
    const embed = anchor.parentElement!;
    const plank = embed.parentElement!;
    assert.equal(embed.querySelector("[data-signup-show]")?.textContent, "Show sign-up form");
    assert.equal(plank.getAttribute("data-block-id"), "signup");
    assert.equal(plank.parentElement?.getAttribute("data-cms-page-blocks"), `page-${"3".repeat(32)}`);
    assert.equal(plank.previousElementSibling?.getAttribute("data-block-id"), "row");
    assert.equal(plank.nextElementSibling?.getAttribute("data-block-id"), "later-copy");
    const click = (selector: string) => {
      const button = document.querySelector(selector);
      assert(button, selector);
      (button as unknown as HTMLElement).click();
    };
    return { document, anchor, embed, click, reloads: () => reloads };
  }
  try {
    const page = openPage(ANALYTICS_CONSENT_DENIED);
    const { document, anchor, click } = page;
    await checkSignupInteraction(page.embed.outerHTML);
    assert.equal(anchor.innerHTML, "");
    assert.equal(document.querySelectorAll("script[data-njpbs-wisepops]").length, 0);
    assert.equal(page.reloads(), 0);

    click("[data-consent-open]");
    click("[data-consent-grant]");
    assert.equal(readAnalyticsConsent(document.cookie), "granted");
    assert.equal(document.querySelectorAll("script[data-njpbs-wisepops]").length, 1);
    assert.equal(anchor.innerHTML, "", "A missing/failed campaign leaves the native anchor inert");
    assert.equal(document.querySelectorAll("#njpbssignup").length, 1);
    click("[data-consent-open]");
    click("[data-consent-grant]");
    assert.equal(document.querySelectorAll("script[data-njpbs-wisepops]").length, 1);

    // Stand in for the campaign that the provider configures against this selector.
    anchor.innerHTML = '<p data-test-campaign>Provider campaign</p>';
    click("[data-consent-open]");
    click("[data-consent-deny]");
    assert.equal(readAnalyticsConsent(document.cookie), "denied");
    assert(page.reloads() > 0, "Existing withdrawal behavior ends the vendor document");
    assert.equal(document.querySelectorAll("#njpbssignup").length, 1);

    const withdrawn = openPage(ANALYTICS_CONSENT_DENIED);
    assert.equal(withdrawn.anchor.innerHTML, "", "Reload preserves the anchor and removes campaign content");
    assert.equal(withdrawn.document.querySelectorAll("script[data-njpbs-wisepops]").length, 0);
    const privatePage = openPage(undefined, true);
    privatePage.click("[data-consent-grant]");
    assert.equal(privatePage.anchor.innerHTML, "");
    assert.equal(privatePage.document.querySelectorAll("script[data-njpbs-wisepops]").length, 0);
  } finally {
    for (const dom of windows) await dom.happyDOM.close();
  }
}
