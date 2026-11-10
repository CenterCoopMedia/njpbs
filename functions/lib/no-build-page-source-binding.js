"use strict";

const { createHash } = require("node:crypto");
const { recordSourceBindingPayload } = require("./no-build-page-source-payload");
function refuse() { throw Object.assign(new Error("Rendered record source binding is unavailable"), { status: 409 }); }
function recordSourceBindingDigest(context) {
  return createHash("sha256").update(recordSourceBindingPayload(context)).digest("hex");
}
function assertRecordSourceBinding(receipt, context) {
  const expected = recordSourceBindingDigest(context);
  if (typeof receipt?.recordSourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.recordSourceDigest) || receipt.recordSourceDigest !== expected) refuse();
  return expected;
}
/** Keep both the existing rendered-input receipt and its selected source seal. */
function readRenderedRecordSourceReceipt(response) {
  const inputDigest = response.headers.get("x-njpbs-input-sha256");
  const recordSourceDigest = response.headers.get("x-njpbs-record-source-sha256");
  if (!/^[a-f0-9]{64}$/.test(inputDigest ?? "") || !/^[a-f0-9]{64}$/.test(recordSourceDigest ?? "")) refuse();
  return { inputDigest, recordSourceDigest };
}
function assertRenderedRecordSourceBinding(receipt, context) {
  const expected = assertRecordSourceBinding(receipt, context);
  const routes = receipt?.routes?.filter(route => [200, 302].includes(route.status));
  if (!Array.isArray(routes) || !routes.length || routes.some(route =>
    !/^[a-f0-9]{64}$/.test(route.inputDigest ?? "") || route.recordSourceDigest !== expected)) refuse();
  return expected;
}
module.exports = { recordSourceBindingDigest, assertRecordSourceBinding,
  readRenderedRecordSourceReceipt, assertRenderedRecordSourceBinding };
