import { beforeEach, describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Source-tree guardrail for issue #571: a doc may not cite an in-repo file
// through the name of somebody's checkout. The briefing docs were written next
// to a second checkout and cited it that way -- `njpbs-site-pbs-wiki/wiki/web/
// njpbs-org.md` for a file this repo has at `site/README.md` -- so every
// pointer read as broken to anyone who did not share that layout.
//
// The rule is the signature of the mistake rather than a list of names: flag a
// pointer that fails as written but resolves once a leading segment is dropped.
// A genuinely external reference (`confluence/...`, a PBS URL) does not resolve
// under any prefix, so it is left alone, and a checkout name nobody has used yet
// is caught the first time it appears. Absolute paths are covered by the same
// test, since `/home/developer/projects/njpbs-site-pbs-wiki/site/README.md` is just a
// longer prefix in front of `CLAUDE.md`.
//
// Runs via npm run guardrails, globbed by vitest.guardrails.config.ts. It reads
// hand-written docs rather than built dist, like the workflow-secret scan.
//
// It cannot tell a citation from an illustration, so a doc teaching link syntax
// has to describe an example path it cannot resolve rather than spell one out.
// That is the intended trade: no allowlist to fall out of date, and a pointer
// printed as a real path stays one a reader can actually open.
//
// #869 widened it twice, each widening chosen so it cannot cry wolf.
//
//   A. Wrong base, against `docs/` only. A pointer like
//      `requirements/accessibility-plan.md` cited from `docs/research/` names a
//      real file at `docs/requirements/accessibility-plan.md`, but no suffix of
//      it resolves, so the #571 rule stayed silent. When a pointer fails as
//      written AND the suffix-drop check finds nothing, it is retried once more
//      against `docs/`. Only `docs/` -- resolving against every directory in the
//      repo would flag every bare `README.md` mention in prose, which is the
//      documented reason the full widening was rejected.
//
//   B. Machine-local absolute paths, at any extension. A span that starts with
//      `/home/`, `/Users/`, or `C:\Users\` is somebody's checkout and never a
//      pointer a reader can open, whether it ends in `.md`, `firebase.json` or
//      nothing at all. It needs no resolution step: the prefix alone is the
//      finding, which is why this one is not restricted to `.md`.
//
// The limits left deliberately open, because a documented limit beats a rule
// that cries wolf:
//
//   * A bare filename resolved against an arbitrary directory. `README.md`,
//     `package.json` and `index.md` exist in a dozen places here, and docs name
//     them as nouns ("each package has a `README.md`") far more often than as
//     pointers. A resolve-anywhere rule would flag nearly all of those. `docs/`
//     is the one base worth the risk, since a doc citing a sibling doc by bare
//     name is the actual observed mistake.
//   * Relative non-`.md` paths. `src/lib/build-target.ts`, `functions/index.ts`
//     and `wrangler.jsonc` are cited constantly and move often; a resolution
//     rule over them would go red on ordinary refactors rather than on broken
//     citations. Widening B covers the only non-`.md` shape that is wrong by
//     construction rather than by drift.
//   * A code span that is the label of a markdown link (`` [`x.md`](../x.md) ``)
//     is skipped by widening A. The pointer a reader follows there is the href,
//     and the offline lychee check in the docs gate already resolves hrefs. This
//     guard is for backticked code spans standing alone in prose -- the shape
//     lychee never sees -- so the two stay complementary rather than doubled up.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scannedRoots = ["docs", "wiki"];
const resolvedFiles = new Map<string, boolean>();

// A doc-relative link and a repo-relative code span are both legitimate, so a
// pointer counts as resolved if either reading finds a file.
function resolvesInRepo(pointer: string, fromFile: string): boolean {
  const candidates = [
    resolve(repoRoot, pointer.replace(/^\/+/, "")),
    resolve(dirname(fromFile), pointer),
  ];
  return candidates.some((abs) => {
    if (!abs.startsWith(repoRoot)) return false;
    if (!resolvedFiles.has(abs)) {
      resolvedFiles.set(abs, statSync(abs, { throwIfNoEntry: false })?.isFile() ?? false);
    }
    return resolvedFiles.get(abs)!;
  });
}

// Returns the offending prefix and the file it found when dropping leading
// segments makes the pointer resolve, and null when the target is simply not in
// this repo. The prefix keeps any leading slash the pointer had, so the
// remediation names a string the document actually contains.
export function checkoutPrefix(
  pointer: string,
  fromFile: string,
): { prefix: string; target: string } | null {
  const leadingSlash = pointer.startsWith("/") ? "/" : "";
  const segments = pointer.replace(/^\/+/, "").split("/");
  for (let i = 1; i < segments.length; i++) {
    const target = segments.slice(i).join("/");
    if (resolvesInRepo(target, fromFile)) {
      return { prefix: leadingSlash + segments.slice(0, i).join("/"), target };
    }
  }
  return null;
}

// Widening A (#869). Retried only after the pointer failed as written and the
// suffix-drop check came back empty, so this never re-explains a finding the
// #571 rule already owns. `docs` is the only base tried; see the header for why.
const WRONG_BASE = "docs";

export function wrongBasePointer(
  pointer: string,
  fromFile: string,
): { base: string; target: string } | null {
  // Absolute, dot-relative and home-relative pointers already say where they
  // start from, so re-rooting them under docs/ would be inventing a reading the
  // document did not ask for.
  if (/^[/.~]/.test(pointer)) return null;
  if (pointer.startsWith(`${WRONG_BASE}/`)) return null;
  const target = `${WRONG_BASE}/${pointer}`;
  return resolvesInRepo(target, fromFile) ? { base: WRONG_BASE, target } : null;
}

// Widening B (#869). No `.md` restriction and no resolution step: the prefix is
// the whole finding, since none of these can name a file in this repository.
const MACHINE_LOCAL = /^(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])/;

export function isMachineLocalPointer(span: string): boolean {
  return MACHINE_LOCAL.test(span);
}

// Every backticked span, not just the `.md` ones POINTER collects.
const CODE_SPAN = /`([^`\n]+)`/g;

export function machineLocalPointersIn(source: string): string[] {
  const found: string[] = [];
  CODE_SPAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_SPAN.exec(source)) !== null) {
    if (isMachineLocalPointer(match[1])) found.push(match[1]);
  }
  return found;
}

// Backticked spans that stand alone in prose, dropping the ones that are a
// markdown link's label -- there the href is the pointer and lychee resolves it.
export function proseCodeSpanPointersIn(source: string): string[] {
  const found: string[] = [];
  CODE_SPAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_SPAN.exec(source)) !== null) {
    const pointer = match[1];
    if (!pointer.endsWith(".md")) continue;
    if (/^(https?:|mailto:|#)/.test(pointer)) continue;
    const after = source.slice(CODE_SPAN.lastIndex);
    const before = source.slice(0, match.index);
    if (before.endsWith("[") && after.startsWith("](")) continue;
    found.push(pointer);
  }
  return found;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

// Read inside the tests, not in the describe body: a throw during collection
// takes the file down before any test registers, so the run reports zero tests
// instead of a failure. (Same reasoning as
// scripts/workflow-secret-guardrail-source.test.ts.)
function scanDocs(): string[] {
  const files = scannedRoots.flatMap((root) => {
    const dir = join(repoRoot, root);
    if (!existsSync(dir)) {
      throw new Error(
        `${dir} is missing. This guardrail's scope is ${scannedRoots.join(" and ")}, ` +
          `so an absent path means the scan silently checks nothing rather than passing.`,
      );
    }
    return markdownFiles(dir);
  });
  if (files.length === 0) {
    throw new Error(
      `No markdown found under ${scannedRoots.join(", ")}. An empty scan means this ` +
        `guardrail lost its target, not that the docs are clean.`,
    );
  }
  return files.sort();
}

// Both citation forms the docs use: a backticked path and a markdown link.
const POINTER =
  /(?:`([^`\n]+?\.md)`|\]\(([^)\s]+?\.md)(?:#[^)]*)?\))/g;

function pointersIn(source: string): string[] {
  const found: string[] = [];
  POINTER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = POINTER.exec(source)) !== null) {
    const pointer = match[1] ?? match[2];
    if (/^(https?:|mailto:|#)/.test(pointer)) continue;
    found.push(pointer);
  }
  return found;
}

describe("docs pointer guardrail (#571)", () => {
  // Repeated citations and dropped prefixes revisit the same paths thousands
  // of times. Cache both hits and misses within one test, never across scans.
  beforeEach(() => resolvedFiles.clear());

  it("cites in-repo files without a checkout-name prefix", () => {
    const findings = scanDocs().flatMap((file) => {
      const relative = file.slice(repoRoot.length);
      return pointersIn(readFileSync(file, "utf8"))
        .filter((pointer) => !resolvesInRepo(pointer, file))
        .map((pointer) => ({ pointer, found: checkoutPrefix(pointer, file) }))
        .filter(({ found }) => found !== null)
        .map(
          ({ pointer, found }) =>
            `${relative}: ${pointer}\n    drop "${found!.prefix}/" and it reads ` +
            `${found!.target}, which is a file in this repo`,
        );
    });

    expect(
      findings,
      findings.length
        ? `Docs cite in-repo files through a checkout name:\n  ${findings.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  it("cites sibling docs from a base a reader can actually follow (#869)", () => {
    const findings = scanDocs().flatMap((file) => {
      const relative = file.slice(repoRoot.length);
      return proseCodeSpanPointersIn(readFileSync(file, "utf8"))
        .filter((pointer) => !resolvesInRepo(pointer, file))
        .filter((pointer) => checkoutPrefix(pointer, file) === null)
        .map((pointer) => ({ pointer, found: wrongBasePointer(pointer, file) }))
        .filter(({ found }) => found !== null)
        .map(
          ({ pointer, found }) =>
            `${relative}: ${pointer}\n    does not resolve as written, but ` +
            `${found!.target} is a file in this repo -- write it that way`,
        );
    });

    expect(
      findings,
      findings.length
        ? `Docs cite files relative to the wrong base:\n  ${findings.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  it("never prints somebody's machine-local path as a pointer (#869)", () => {
    const findings = scanDocs().flatMap((file) => {
      const relative = file.slice(repoRoot.length);
      return machineLocalPointersIn(readFileSync(file, "utf8")).map(
        (pointer) =>
          `${relative}: ${pointer}\n    names a path on one machine, which no ` +
          `reader can open -- cite the repo-relative path instead`,
      );
    });

    expect(
      findings,
      findings.length
        ? `Docs print machine-local absolute paths:\n  ${findings.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  // The scan above passing on a clean tree proves nothing about the rule, and
  // the canary below is satisfied by ordinary markdown links, so the branch that
  // reads a backticked path -- the whole reason this exists, since links are
  // already lychee's job in the docs gate -- could be deleted with both tests
  // still green. These cases exercise the rule directly, on a real file, so the
  // detection has to keep working and not merely keep quiet.
  it("recognizes the pointer shapes it has to catch, and leaves the rest alone", () => {
    const from = join(repoRoot, "docs/research/content-migration-and-seo.md");
    const inRepo = "site/README.md";

    expect(checkoutPrefix(`njpbs-site-pbs-wiki/${inRepo}`, from)).toEqual({
      prefix: "njpbs-site-pbs-wiki",
      target: inRepo,
    });
    // An absolute path is the same mistake behind a longer prefix, and the
    // reported prefix has to keep its leading slash to match the document.
    expect(
      checkoutPrefix("/home/developer/projects/njpbs-site-pbs-wiki/site/README.md", from),
    ).toEqual({
      prefix: "/home/developer/projects/njpbs-site-pbs-wiki",
      target: "site/README.md",
    });
    // Genuinely external: no suffix of this resolves here, so it is left alone.
    expect(
      checkoutPrefix("confluence/5343868_roles-and-permissions.md", from),
    ).toBeNull();
    // Both citation forms have to be seen. Markdown links are lychee's job too;
    // a backticked path is this scan's alone.
    expect(pointersIn("see `site/README.md` for the zone")).toEqual([
      "site/README.md",
    ]);
    expect(pointersIn("see [the zone](../../site/README.md)")).toEqual([
      "../../site/README.md",
    ]);
  });

  // Same reasoning for the #869 widenings: both scans are green on this tree, so
  // either rule could be gutted and stay quiet. These exercise them directly.
  it("catches a wrong-base pointer without catching a bare filename (#869)", () => {
    const from = join(repoRoot, "docs/research/content-migration-and-seo.md");

    // The reported class: written for a reader standing in docs/, cited from
    // docs/research/, so neither reading of it resolves.
    expect(wrongBasePointer("requirements/compliance-matrix.md", from)).toEqual({
      base: "docs",
      target: "docs/requirements/compliance-matrix.md",
    });
    // Already correct from the repo root: not this rule's business.
    expect(
      wrongBasePointer("docs/requirements/compliance-matrix.md", from),
    ).toBeNull();
    // Nothing under docs/ answers to this, so it is external and left alone.
    expect(
      wrongBasePointer("confluence/5343868_roles-and-permissions.md", from),
    ).toBeNull();
    // A pointer that says where it starts from is taken at its word.
    expect(wrongBasePointer("../transition-assets.md", from)).toBeNull();
    expect(wrongBasePointer("~/njpbs-research/synthesis/site-spec.md", from)).toBeNull();

    // A code span standing in prose is a pointer; the same span used as a link
    // label is not, because the href beside it is what a reader follows and
    // lychee already resolves that.
    expect(proseCodeSpanPointersIn("the inventory (`transition-assets.md`)")).toEqual([
      "transition-assets.md",
    ]);
    expect(
      proseCodeSpanPointersIn("sourced to [`transition-assets.md`](../transition-assets.md)"),
    ).toEqual([]);
  });

  it("catches a machine-local path at any extension (#869)", () => {
    expect(isMachineLocalPointer("/home/developer/projects/cjs2026/firebase.json")).toBe(true);
    expect(isMachineLocalPointer("/Users/developer/njpbs-site/wrangler.jsonc")).toBe(true);
    expect(isMachineLocalPointer("C:\\Users\\developer\\njpbs-site")).toBe(true);
    // In-repo and genuinely external paths are not somebody's home directory.
    expect(isMachineLocalPointer("site/src/lib/build-target.ts")).toBe(false);
    expect(isMachineLocalPointer("/site/README.md")).toBe(false);
    expect(isMachineLocalPointer("cd /home/user && ls")).toBe(false);

    // The extraction has to see spans the `.md` pattern never collects.
    expect(
      machineLocalPointersIn("run it from `/home/developer/projects/cjs2026/firebase.json`"),
    ).toEqual(["/home/developer/projects/cjs2026/firebase.json"]);
    expect(machineLocalPointersIn("run it from `functions/index.ts`")).toEqual([]);
  });

  it("still finds pointers to check in the docs it scans", () => {
    // The quiet way for this guardrail to die is the pointer pattern drifting
    // out of step with how the docs cite things: every file still gets read,
    // nothing matches, and a silent zero reads exactly like a clean tree.
    const withoutPointers = scanDocs().filter(
      (file) => pointersIn(readFileSync(file, "utf8")).length === 0,
    );

    expect(
      withoutPointers.length,
      `Every scanned file matched zero pointers, so the pattern no longer matches ` +
        `how these docs cite files and the scan above cannot fail.`,
    ).toBeLessThan(scanDocs().length);
  });
});
