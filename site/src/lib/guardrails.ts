// Mechanical guardrail check over the BUILT public HTML.
//
// The binding client guardrails (see site/README.md) are mostly semantic and
// belong to copy review. The remaining mechanically crisp one is enforced here,
// so CI runs this over dist/*.html and dist/*.css and fails the build on any hit:
//
//   1. logo-image — a reference to old P-head/logo/wordmark filenames. Approved
//      NJ PBS brand assets live under public/brand and favicon.png.
//   2. operator-ownership — a false Montclair/MSU/CCM ownership claim. Montclair
//      operates NJ PBS; the State/NJPBA remains the license holder.
//   3. legacy-host: a link or resource reference to a WNET-era host.
//   4. legacy-path: an absolute apex link to a path that the legacy classifier
//      handles with a 301 or 410.
//
// The operator/licensee distinction is mechanically checkable. Unsupported
// launch/integration claims require copy review with their source context.

import { classify } from "./legacy-redirects";
import { LEGACY_HOST_LINK_OPT_IN_ATTRIBUTE } from "../../../packages/content-core/src/content-model";

export interface GuardrailViolation {
  rule: string;
  match: string;
  message: string;
}

const RULE_MESSAGES: Record<string, string> = {
  "logo-image": "Replace this legacy logo image with an approved asset from /brand/.",
  "operator-ownership":
    "Rewrite this claim to say Montclair operates NJ PBS; the State/NJPBA holds the licenses.",
  "legacy-host":
    'Replace this link with a current destination. To keep an intentional WNET-era link, open its CMS link settings and select "Allow this WNET-era host link." Source authors can add data-allow-legacy-host="true" to that <a>.',
  "legacy-path":
    "Replace this legacy NJ PBS path with a current public route. The WNET-era host opt-in does not apply to same-domain legacy paths.",
};

function violation(rule: string, match: string): GuardrailViolation {
  return { rule, match, message: RULE_MESSAGES[rule] };
}

// A logo/wordmark image filename, referenced via src=, href=, or CSS url().
const FORBIDDEN_ASSET =
  /(?:src|href)\s*=\s*["']([^"']*(?:pbs[-_]?p?head|p-?head|pbs[-_]?logo|pbs[-_]?wordmark|njpbs[-_]?logo|njpbs[-_]?wordmark)[^"']*)["']|url\(\s*["']?([^)"']*(?:pbs[-_]?p?head|p-?head|pbs[-_]?logo|pbs[-_]?wordmark|njpbs[-_]?logo|njpbs[-_]?wordmark)[^)"']*)["']?\s*\)/gi;

const OPERATOR_ENTITY =
  "(?:Montclair(?: State University)?|MSU|CCM|College of Communication and Media)";
const NJPBS_TARGET =
  "(?:NJ PBS|the NJ PBS licenses?|the NJ PBS stations?|the stations?|the licenses?)";
const FORBIDDEN_OPERATOR_OWNERSHIP = new RegExp(
  String.raw`\b${OPERATOR_ENTITY}\b[\s\S]{0,80}\bowns?\b[\s\S]{0,60}\b${NJPBS_TARGET}\b|\b${NJPBS_TARGET}\b[\s\S]{0,80}\b(?:is|are)\b[\s\S]{0,30}\bowned by\b[\s\S]{0,60}\b${OPERATOR_ENTITY}\b`,
  "gi",
);

// Match the explicit legacy-host denylist in navigation and resource contexts.
// A legacy URL can remain syntactically valid while directing readers or asset
// requests to the wrong service; HTTP success alone does not admit it.
//
// The lookahead is what makes this a host match rather than a prefix match. The
// authority ends at a slash, a query, a fragment, a port, a comma, a closing
// quote or parenthesis, or whitespace, so thirteen.organic.org and
// foo.wnet.org.example.com are other people's domains and do not fail this build.
const LEGACY_HOST =
  String.raw`(?:[a-z0-9-]+\.)*(?:njtvonline\.org|thirteen\.org|wnet\.org)` +
  String.raw`(?=[/?#:,"')\s]|$)`;

// Link and resource contexts only, because the rule is about where a CTA sends a
// reader or which host supplies an asset rather than which hosts a page is
// allowed to name. Three things it therefore leaves alone, all of them things
// this site legitimately publishes:
//
//   "WNET operated NJ PBS from July 1, 2011"   correct history (faq.md)
//   A mailto contact at a legacy host                            a person to write to about the
//                                              handoff, not a destination
//   a printed https://thirteen.org/... URL     naming where something was
//                                              published is not sending anyone
//                                              there
//
// A citation written as a real anchor is a different matter, and this rule does
// flag it outside the wiki subtree exempted by isGuardrailExemptPath. A source
// author must explicitly opt in where the link contract permits it.
//
// This rule flags only its explicit legacy-host set. Other destinations
// remain subject to the separate route, resource and source-admission guards.
//
// The scheme is optional in the src/href branch on purpose.
// href="njtvonline.org/live" is a relative URL by the letter of HTML, so a browser
// resolves it against njpbs.org and serves a 404. That is what a half-pasted CTA
// looks like, and it is worth failing the build over in either reading. The cost
// of allowing it is a route whose first path segment is literally njtvonline.org,
// which is not a page anyone will write. The CSS and srcset branches keep the
// authority marker required, because a bare path there really is relative and
// carries no host at all.
const FORBIDDEN_LEGACY_HOST = new RegExp(
  String.raw`(?:src|href)\s*=\s*["'](?:https?:)?(?:\/\/)?${LEGACY_HOST}[^"']*["']` +
    String.raw`|srcset\s*=\s*["'][^"']*(?:https?:)?\/\/${LEGACY_HOST}[^"']*["']` +
    String.raw`|url\(\s*["']?(?:https?:)?\/\/${LEGACY_HOST}[^)"']*["']?\s*\)` +
    String.raw`|@import\s+["'](?:https?:)?\/\/${LEGACY_HOST}[^"']*["']`,
  "gi",
);

const LEGACY_HOST_OPT_IN = new RegExp(
  String.raw`(?:^|\s)${LEGACY_HOST_LINK_OPT_IN_ATTRIBUTE}\s*=\s*(["'])([^"']*)\1`,
  "i",
);

// The opt-in belongs to one anchor href. A marker on a parent, sibling, image,
// stylesheet, or other resource reference cannot suppress the legacy-host rule.
function hasLegacyHostLinkOptIn(
  html: string,
  match: RegExpMatchArray,
): boolean {
  if (!/^href\s*=/i.test(match[0]) || match.index === undefined) return false;

  const tagStart = html.lastIndexOf("<", match.index);
  const tagEnd = html.indexOf(">", match.index + match[0].length);
  if (tagStart < 0 || tagEnd < 0) return false;

  const openingTag = html.slice(tagStart, tagEnd + 1);
  if (!/^<a(?:\s|>)/i.test(openingTag)) return false;

  const optIn = LEGACY_HOST_OPT_IN.exec(openingTag);
  return optIn?.[2] === "true";
}

function collectLegacyHostViolations(html: string): GuardrailViolation[] {
  const out: GuardrailViolation[] = [];
  for (const match of html.matchAll(FORBIDDEN_LEGACY_HOST)) {
    if (hasLegacyHostLinkOptIn(html, match)) continue;
    out.push(violation("legacy-host", match[0].trim()));
  }
  return out;
}

// Absolute links to the NJ PBS apex can preserve a WNET-era path even when the
// copied CTA no longer names a WNET host. Read every absolute href, parse its
// authority rather than prefix-matching it, and let the edge classifier decide
// whether the path is legacy. This keeps the guardrail aligned with the current
// redirect/410 inventory while its protected-prefix rules and pass-through
// default leave new route families such as /posts, /authors, /shows and /wiki
// available.
const ABSOLUTE_HREF = /href\s*=\s*(["'])((?:https?:)?\/\/[^"'<>\s]+)\1/gi;
const NJPBS_APEX_HOSTS = new Set(["njpbs.org", "www.njpbs.org"]);

function collectLegacyPathViolations(html: string): GuardrailViolation[] {
  const out: GuardrailViolation[] = [];

  for (const match of html.matchAll(ABSOLUTE_HREF)) {
    const href = match[2];
    let url: URL;
    try {
      url = new URL(href.startsWith("//") ? `https:${href}` : href);
    } catch {
      continue;
    }

    if (
      NJPBS_APEX_HOSTS.has(url.hostname.toLowerCase()) &&
      classify(url.pathname) !== null
    ) {
      out.push(violation("legacy-path", match[0].trim()));
    }
  }

  return out;
}

function collect(
  html: string,
  pattern: RegExp,
  rule: string,
): GuardrailViolation[] {
  const out: GuardrailViolation[] = [];
  // matchAll needs the /g flag (all three patterns have it) and iterates every hit
  // without the manual lastIndex bookkeeping a stateful loop would require.
  for (const m of html.matchAll(pattern)) {
    out.push(violation(rule, m[0].trim()));
  }
  return out;
}

export function findGuardrailViolations(html: string): GuardrailViolation[] {
  if (!html) return [];
  return [
    ...collect(html, FORBIDDEN_ASSET, "logo-image"),
    ...collect(html, FORBIDDEN_OPERATOR_OWNERSHIP, "operator-ownership"),
    ...collectLegacyHostViolations(html),
    ...collectLegacyPathViolations(html),
  ];
}

// Which emitted files the dist gate scans. FORBIDDEN_ASSET matches a logo image
// referenced from HTML (src=/href=) or CSS (url()), and the public chooser links
// external kit CSS — so stylesheets must be scanned alongside pages, or the CSS
// branch of the rule never sees a real file. JS and binary assets are out of
// scope: the src/href/url() syntax the rules key on does not live there.
export function isScannableAsset(filename: string): boolean {
  return filename.endsWith(".html") || filename.endsWith(".css");
}

// The public OKF wiki (dist/wiki/**) is exempt from the deploy guardrail. The wiki
// is a different artifact: the provenance-tracked fact layer, governed by its own
// source/verified discipline (see wiki/README.md).
export function isGuardrailExemptPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return p === "wiki" || p.startsWith("wiki/");
}
