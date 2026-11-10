// @vitest-environment node
// WCAG 1.4.2 (audio control) and 2.2.2 (pause, stop, hide): media the site itself
// authors must not autoplay with sound. NJ PBS video is delivered by the PBS Media
// Manager Partner Player embed, so this does not police that iframe (autoplay there
// is a URL parameter on a PBS-hosted surface, not an HTML attribute the site sets).
// It locks the invariant for native <video>/<audio> authored directly in the tree:
// an autoplaying <video> must be muted, and <audio> must never autoplay. There is no
// such element in the tree today, and the watch/live/kids pages carry Partner Player
// slots rather than real players; this is the tripwire that keeps the promise true as
// those slots grow into real embeds, in the same spirit as external-link-cue.test.ts.
// Source-level, like the sibling guards: a component that renders a <video> from an
// expression is better checked against built HTML, tracked separately.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

// Every .astro (components, islands, layouts, pages) plus every markdown content
// page: both can author raw media HTML.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(astro|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const files = walk(SRC);

const VIDEO_TAG = /<video\b[^>]*>/gis;
const AUDIO_TAG = /<audio\b[^>]*>/gis;

// How `attr` appears on the element, using HTML boolean-attribute semantics rather
// than JS truthiness. A bare word match gets two things wrong. First, `data-autoplay`
// (the `-` is a word boundary) must not count as `autoplay`; the leading `(?:^|\s)`
// excludes hyphenated names. Second, presence is what matters, not value:
// `autoplay="false"` still autoplays because HTML ignores a boolean attribute's
// value, so a quoted or bare value always counts as present.
//
// The three states are the three answers a source-level scan can honestly give. An
// Astro expression that is not a literal is `dynamic`: render time decides, and the
// source does not know which way. Collapsing that into a boolean is what forces the
// caller to guess, so it stays a distinct state and each rule below resolves it in
// the direction that is safe for that rule.
// `dynamic` carries the source text of the condition. Two attributes can be proven
// to render together only when they reuse the same stable local; repeated calls or
// property reads may return different values when Astro evaluates them separately.
type AttrRead =
  | { state: "absent" }
  | { state: "present" }
  | { state: "dynamic"; expr: string };

function readAttr(tag: string, attr: string): AttrRead {
  const re = new RegExp(
    `(?:^|\\s)${attr}(?=[\\s=>/])(?:=(\\{[^}]*\\}|"[^"]*"|'[^']*'|[^\\s>]+))?`,
    "i",
  );
  const m = tag.match(re);
  if (!m) return { state: "absent" };
  const raw = m[1];
  if (raw === undefined) return { state: "present" }; // bare boolean attribute
  if (raw.startsWith("{")) {
    // Collapse whitespace so formatting differences do not defeat the comparison
    // below, but keep case: JavaScript identifiers are case-sensitive.
    const expr = raw.slice(1, -1).trim().replace(/\s+/g, " ");
    const literal = expr.toLowerCase();
    // Only these literals omit the attribute from the rendered HTML.
    if (["false", "null", "undefined", ""].includes(literal)) return { state: "absent" };
    if (literal === "true") return { state: "present" };
    return { state: "dynamic", expr };
  }
  return { state: "present" }; // any quoted or unquoted value renders the attribute
}

// WCAG 1.4.2 asks one question of a <video>: on any render where it autoplays, is it
// muted? So this is not two independent presence checks. It is an implication, and
// the interesting case is the one where neither attribute is a literal.
//
// Three of the four branches are decidable outright. The fourth is the reason the
// condition text is kept: `autoplay={x} muted={x}` renders both attributes together
// or neither when `x` is one stable local. Identical calls or property reads do not
// prove that because Astro evaluates each attribute separately; assign those to a
// local first. `autoplay={x} muted={y}` also fails, as does a bare `autoplay` beside
// a conditional `muted`.
const STABLE_CONDITION = /^[A-Za-z_$][\w$]*$/;

function stableConditionName(expr: string): string | null {
  let candidate = expr.trim();
  // Parentheses around one local do not change what is read. Peel matching outer
  // pairs before applying the strict identifier check; a call, member access, or
  // compound expression still leaves non-identifier syntax and is rejected.
  while (candidate.startsWith("(") && candidate.endsWith(")")) {
    candidate = candidate.slice(1, -1).trim();
  }
  return STABLE_CONDITION.test(candidate) ? candidate : null;
}

const isUnmutedAutoplayVideo = (tag: string): boolean => {
  const autoplay = readAttr(tag, "autoplay");
  if (autoplay.state === "absent") return false; // never autoplays, nothing to prove
  const muted = readAttr(tag, "muted");
  if (muted.state === "present") return false; // muted on every render
  if (muted.state === "absent") return true; // autoplays and is never muted
  // Both conditional: safe only when the same stable local drives both attributes.
  // A call runs twice and a dotted path can invoke a getter, so repeated source text
  // alone is not a coupling guarantee.
  const autoplayCondition =
    autoplay.state === "dynamic" ? stableConditionName(autoplay.expr) : null;
  return !(
    autoplayCondition !== null &&
    autoplayCondition === stableConditionName(muted.expr)
  );
};

// <audio> has no muted escape hatch in this rule: the site does not autoplay audio at
// all, so any autoplay counts, and an unresolvable condition counts as autoplay.
const isAutoplayAudio = (tag: string) => readAttr(tag, "autoplay").state !== "absent";

// Collect every opening tag matching `re` for which `isBad` holds, tagged with its
// file, so a failure names the offending element and page.
function offenders(re: RegExp, isBad: (tag: string) => boolean): string[] {
  const bad: string[] = [];
  for (const full of files) {
    const rel = full.slice(SRC.length + 1);
    for (const m of readFileSync(full, "utf8").matchAll(re)) {
      if (isBad(m[0])) bad.push(`${rel}: ${m[0].replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return bad;
}

const matches = (html: string, re: RegExp, rule: (tag: string) => boolean) =>
  [...html.matchAll(re)].some((m) => rule(m[0]));

describe("site-authored media does not autoplay with sound (WCAG 1.4.2, 2.2.2)", () => {
  it("every autoplaying <video> is muted", () => {
    const bad = offenders(VIDEO_TAG, isUnmutedAutoplayVideo);
    expect(
      bad,
      `autoplaying <video> that is not provably muted. Either write a bare \`muted\`,\n` +
        `or assign the condition to one local and reuse it: autoplay={auto} muted={auto}.\n` +
        `Calls, property reads, and two different conditions can evaluate separately,\n` +
        `so they are not a source-level guarantee.\n${bad.join("\n")}`,
    ).toEqual([]);
  });

  it("no site-authored <audio> autoplays", () => {
    const bad = offenders(AUDIO_TAG, isAutoplayAudio);
    expect(bad, `autoplaying <audio> (remove autoplay):\n${bad.join("\n")}`).toEqual([]);
  });

  // There is no offending media in the tree today, so both scans pass over an empty
  // match set. That is a trap: if the SRC path, the walk, the regex, or readAttr
  // ever broke, the guard would keep passing while enforcing nothing. These checks
  // prove the guard is still live -- it reaches real files and still flags the exact
  // patterns it exists to catch -- so an empty result means "clean", never "asleep".
  it("is still scanning real source files", () => {
    expect(
      files.length,
      "media guard scanned no source files: the walk reached src/ but matched " +
        "nothing, so check the extension filter. A wrong SRC path does not land " +
        "here at all, since readdirSync throws while this module loads.",
    ).toBeGreaterThan(0);
  });

  it("still flags the patterns it guards against", () => {
    expect(matches('<video autoplay src="x"></video>', VIDEO_TAG, isUnmutedAutoplayVideo)).toBe(true);
    expect(matches('<audio autoplay src="x"></audio>', AUDIO_TAG, isAutoplayAudio)).toBe(true);
    // and does not flag a compliant element
    expect(matches('<video autoplay muted src="x"></video>', VIDEO_TAG, isUnmutedAutoplayVideo)).toBe(false);
  });

  // The conditional cases, which are where the rule earns its keep. Asking only
  // whether `muted` is present, and reading any expression as yes, scores a
  // conditional `muted` as proof of muting.
  it("holds a conditional <video> to the implication, not to attribute presence", () => {
    const bad = (html: string) => matches(html, VIDEO_TAG, isUnmutedAutoplayVideo);

    // A condition that can leave an autoplaying video unmuted.
    expect(bad('<video autoplay muted={wantsSound ? false : true}></video>')).toBe(true);
    expect(bad('<video autoplay muted={isMuted}></video>')).toBe(true);
    // Two independent conditions: nothing ties them, so this is not provable.
    expect(bad('<video autoplay={shouldPlay} muted={isMuted}></video>')).toBe(true);
    // Autoplay conditional, muted missing entirely.
    expect(bad('<video autoplay={shouldPlay}></video>')).toBe(true);

    // One condition driving both attributes: they render together or not at all, so
    // the implication holds whatever the condition evaluates to.
    expect(bad('<video autoplay={shouldPlay} muted={shouldPlay}></video>')).toBe(false);
    // and formatting inside the braces does not change that
    expect(bad('<video autoplay={ shouldPlay } muted={shouldPlay}></video>')).toBe(false);
    // Parentheses do not make reading the local less stable.
    expect(bad('<video autoplay={(shouldPlay)} muted={((shouldPlay))}></video>')).toBe(false);
    // but case does, because JavaScript identifiers are case-sensitive
    expect(bad('<video autoplay={shouldPlay} muted={shouldplay}></video>')).toBe(true);

    // Repeating source text is not enough when evaluating it twice can produce two
    // values. Calls run twice, and a dotted path can be backed by a getter. Authors
    // must assign either shape to one local before reusing it for both attributes.
    expect(bad('<video autoplay={nextFlag()} muted={nextFlag()}></video>')).toBe(true);
    expect(bad('<video autoplay={player.auto} muted={player.auto}></video>')).toBe(true);

    // Literals resolve without any of the above.
    expect(bad('<video autoplay muted={true}></video>')).toBe(false);
    expect(bad('<video autoplay muted="false"></video>')).toBe(false); // HTML ignores the value
    expect(bad('<video autoplay={false} muted={isMuted}></video>')).toBe(false);
  });

  it("counts a conditional autoplay on <audio> as autoplay", () => {
    expect(matches('<audio autoplay={shouldPlay}></audio>', AUDIO_TAG, isAutoplayAudio)).toBe(true);
    expect(matches('<audio autoplay={false}></audio>', AUDIO_TAG, isAutoplayAudio)).toBe(false);
  });
});
