"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pairingApprovalUrl } = require("../pairing.js");
const approvalUrl = "https://admin.njpbs.org/premiere/connect";

test("uses the server-owned complete approval URL and falls back for old functions", () => {
  assert.equal(pairingApprovalUrl({ userCode: "KXQR-7M2P", verificationUriComplete: "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P" }, approvalUrl),
    "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P");
  assert.equal(pairingApprovalUrl({ userCode: "KXQR-7M2P" }, approvalUrl), approvalUrl);
});

test("the local build prefills its configured local Admin instead of opening production", () => {
  assert.equal(pairingApprovalUrl({ userCode: "KXQR-7M2P", verificationUriComplete: "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P" },
    "http://localhost:5173/premiere/connect"), "http://localhost:5173/premiere/connect?code=KXQR-7M2P");
});

test("a response cannot redirect the editor or supply a different code", () => {
  for (const verificationUriComplete of ["javascript:alert(1)", "https://example.test/premiere/connect?code=KXQR-7M2P",
    "https://admin.njpbs.org.evil.test/premiere/connect?code=KXQR-7M2P", "http://admin.njpbs.org/premiere/connect?code=KXQR-7M2P",
    "https://admin.njpbs.org/premiere/connect?code=ABCD-2345", "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P&next=https://example.test",
    "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P#other", "", null]) {
    assert.equal(pairingApprovalUrl({ userCode: "KXQR-7M2P", verificationUriComplete }, approvalUrl), approvalUrl);
  }
  assert.equal(pairingApprovalUrl({ userCode: "KXQR-7M2P\n", verificationUriComplete: "https://admin.njpbs.org/premiere/connect?code=KXQR-7M2P%0A" }, approvalUrl), approvalUrl);
});
