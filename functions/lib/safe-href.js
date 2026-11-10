// CommonJS deployment mirror of packages/content-core/src/safe-href.ts.
// Keep behavior aligned through Home hero parity tests.
"use strict";
// The link-safety and HTML-escaping primitives the whole content core shares.
//
// These lived in content-model.ts, and content-model.ts still re-exports them so no
// call site changed. They are a separate leaf module now because the dynamic-shelf
// query contract (#1046) has to judge a catalog link with exactly the renderer's rule,
// and content-model.ts imports the shelf contract for its block payloads -- so the two
// cannot import each other. A leaf both sides import keeps one implementation of a
// security-relevant check rather than a second copy that can drift.
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = escapeHtml;
exports.safeHref = safeHref;
exports.isSafeHref = isSafeHref;
const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};
// Exported so the shared block renderer (content-render.ts) escapes plain-text
// block fields through the same table, rather than duplicating a security-relevant
// helper.
function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
// Schemes safe to emit into an href. A scheme-bearing link must use one of these;
// a scheme-less link (a relative path like `about` or `../donate`, an anchor, or a
// query) is always allowed -- except a protocol-relative `//host` URL, which carries no
// parsed scheme but still resolves as an external link and is rejected in safeHref.
// This blocks `javascript:` and `data:` while keeping the ordinary internal links
// editors write. Web addresses must not contain a username or password.
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
function safeHref(raw) {
    if (typeof raw !== "string")
        return null;
    // Strip the C0 control characters and DEL a browser removes before parsing, so a
    // `java\nscript:` cannot smuggle a blocked scheme past the scheme check.
    // eslint-disable-next-line no-control-regex -- Reject ASCII controls in user-supplied links.
    const href = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (href.length === 0)
        return null;
    // A protocol-relative URL like `//host/...` has no parsed scheme but resolves as an
    // external link against the page's own protocol -- not the relative/anchor/query link
    // the scheme-less path is meant to allow. Browsers also read a backslash as a slash in
    // the authority, so normalize first and reject anything that resolves to `//...`.
    if (href.replace(/\\/g, "/").startsWith("//"))
        return null;
    const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
    const protocol = scheme?.[1].toLowerCase();
    if (protocol && !SAFE_SCHEMES.has(protocol))
        return null;
    if (protocol === "http" || protocol === "https") {
        try {
            const url = new URL(href);
            if (url.username || url.password)
                return null;
        }
        catch {
            return null;
        }
    }
    return href;
}
// Whether the renderer would emit this href rather than strip it: the canonical
// link-safety test, shared so the editor's link tool can offer exactly what the
// renderer keeps. It reuses safeHref, so the scheme allowlist and the
// protocol-relative and control-character rules live in one place and cannot drift
// between the editor and the published page.
function isSafeHref(raw) {
    return safeHref(raw) !== null;
}
