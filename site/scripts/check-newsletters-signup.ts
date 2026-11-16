import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { ANALYTICS_CONSENT_DENIED, initAnalyticsConsent, readAnalyticsConsent } from "../src/lib/analytics-consent";
import { WISEPOPS_CONSENT_SNIPPET } from "../src/lib/analytics-consent-head";

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
    const plank = anchor.parentElement!;
    assert.equal(plank.getAttribute("data-block-id"), "signup");
    assert.equal(plank.parentElement?.getAttribute("data-cms-page-blocks"), `page-${"3".repeat(32)}`);
    assert.equal(plank.previousElementSibling?.getAttribute("data-block-id"), "row");
    assert.equal(plank.nextElementSibling?.getAttribute("data-block-id"), "later-copy");
    const click = (selector: string) => {
      const button = document.querySelector(selector);
      assert(button, selector);
      (button as unknown as HTMLElement).click();
    };
    return { document, anchor, click, reloads: () => reloads };
  }
  try {
    const page = openPage(ANALYTICS_CONSENT_DENIED);
    const { document, anchor, click } = page;
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
