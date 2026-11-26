"use strict";
// Marks an error whose message is fixed project text, so the cloud release
// failure record may copy it.
//
// Rule: mark a status-bearing refusal only when every message it can carry is a
// string literal, a named constant, or a template that interpolates validated
// project identifiers or limits. Never mark an error built from editorial or
// user text, request input, document fields, or another error's message.
// Mark an Error class itself only when its constructor takes no message text;
// for a class that accepts text, mark each call site that passes a literal.
//
// Scope (coordinator ruling, Nov. 26, 2026): every such literal refusal in the
// modules site/scripts/no-build-cloud-release.ts loads is marked. A mark only
// lets a fixed project message through when the release recorder reads it; on
// paths the recorder never reaches it is inert. Marking every literal refusal
// covers the next path the release reaches without a new sweep. Provider and
// adapter errors never carry this mark.
const OPERATOR_REFUSAL = Symbol.for("njpbs.operator-refusal");
function operatorRefusal(error) {
  Object.defineProperty(error, OPERATOR_REFUSAL, { value: true });
  return error;
}
function isOperatorRefusal(error) {
  try {
    return error instanceof Error && Object.getOwnPropertyDescriptor(error, OPERATOR_REFUSAL)?.value === true;
  } catch { return false; }
}
module.exports = { operatorRefusal, isOperatorRefusal };
