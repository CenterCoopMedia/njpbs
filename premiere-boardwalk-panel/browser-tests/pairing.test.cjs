"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { openPairingPanel, pairing } = require("./pairing-fixture.cjs");

test("connect and reopen use the same complete URL, while old functions use the fixed fallback", async t => {
  for (const response of [pairing, { ...pairing, verificationUriComplete: undefined }]) {
    const { page, errors, close } = await openPairingPanel({ response });
    try {
      await page.getByRole("button", { name: "Open Boardwalk", exact: true }).click();
      const expectedUrl = response.verificationUriComplete ? "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P"
        : "https://admin.njpbs.org/premiere/connect";
      assert.deepEqual(await page.evaluate(() => window.openedUrls), [expectedUrl, expectedUrl]);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "Copy code", exact: true }).isVisible(), false);
      assert.equal(await page.getByRole("button", { name: "Connect Boardwalk", exact: true })
        .evaluate(el => el === document.activeElement), true);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  }
});

for (const width of [260, 400]) {
  test(`at ${width}px, the code is selectable and keyboard Copy code reports UXP success/failure`, async () => {
    const { page, errors, close } = await openPairingPanel({ width });
    try {
      const code = page.getByRole("textbox", { name: "Connection code", exact: true });
      assert.equal(await code.inputValue(), "KXQR-7M2P");
      assert.equal(await code.getAttribute("readonly"), "");
      assert.equal(await code.evaluate(el => el === document.activeElement), true);
      await code.press("Control+a");
      assert.equal(await code.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), "KXQR-7M2P");
      await code.press("Tab");
      const copy = page.getByRole("button", { name: "Copy code", exact: true });
      assert.equal(await copy.evaluate(el => el === document.activeElement), true);
      await copy.press("Enter");
      await page.getByText("Code copied.", { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.copiedContent), [{ "text/plain": "KXQR-7M2P" }]);
      assert.equal(await page.getByText("Code copied.", { exact: true }).getAttribute("aria-live"), "polite");
      await page.evaluate(() => { window.copyFailure = true; });
      await copy.press("Space");
      await page.getByText("Could not copy. Select the code and copy it.", { exact: true }).waitFor();
      await page.evaluate(() => { delete navigator.clipboard.setContent; });
      await copy.press("Enter");
      await page.getByText("Could not copy. Select the code and copy it.", { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.copiedContent), [{ "text/plain": "KXQR-7M2P" }]);
      await page.getByText("The hyphen is optional.", { exact: true }).waitFor();
      assert.equal(await page.locator("#content").evaluate(el => el.scrollWidth > el.clientWidth), false);
      // The full value fits inside its field, rather than hiding digits in an input scroll area.
      assert.equal(await code.evaluate(el => el.scrollWidth > el.clientWidth), false);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}
