"use strict";

const verificationUri = "https://admin.njpbs.org/premiere/connect";

function pairingApprovalUrl(pair, fallback) {
  // Keep the fixed approval destination: a server response cannot redirect the editor.
  if (typeof pair.userCode !== "string" || pair.userCode.length !== 9 ||
      !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(pair.userCode) ||
      pair.verificationUriComplete !== `${verificationUri}?code=${encodeURIComponent(pair.userCode)}`) return fallback;
  if (fallback === verificationUri) return pair.verificationUriComplete;
  // The emulator returns the production URL too; local builds retain their local Admin.
  const localUrl = new URL(fallback);
  localUrl.searchParams.set("code", pair.userCode);
  return localUrl.href;
}

module.exports = { pairingApprovalUrl };
