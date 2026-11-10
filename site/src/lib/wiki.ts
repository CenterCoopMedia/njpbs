// Pure helpers for rendering the OKF wiki bundle (repo-root `wiki/`) as the
// public knowledge base at /wiki/. No DOM, no fs, no Astro — unit-tested in
// tests/wiki.test.ts so the slug math and the link rewriting are pinned.
//
// The wiki is an Open Knowledge Format bundle: one markdown+frontmatter file per
// concept, linked by relative `.md` links. To publish a curated subset as HTML we
// must (1) turn a glob-loader entry id into a clean URL, and (2) rewrite the
// in-body `.md` links so a link to a PUBLIC concept points at its rendered route,
// while a link to a non-public concept — or to a file outside the bundle (the
// deep `docs/` research) — is redacted to plain text, so an internal target is
// never linked from the public render.

export const WIKI_BASE = "/wiki";
export const WIKI_DIR_IN_REPO = "wiki";

/** Directory portion of a slash-separated id ("org/nj-pbs" -> "org", "x" -> ""). */
export function dirOf(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? "" : id.slice(0, i);
}

/** glob-loader entry id -> URL slug under /wiki/ (no leading/trailing slash). */
export function idToSlug(id: string): string {
  if (id === "index") return "";
  if (id.endsWith("/index")) return id.slice(0, -"/index".length);
  return id;
}

/** A wiki slug -> absolute site path (directory route, trailing slash). */
export function slugToPath(slug: string): string {
  return slug ? `${WIKI_BASE}/${slug}/` : `${WIKI_BASE}/`;
}

/** Convenience: entry id straight to its rendered path. */
export function idToPath(id: string): string {
  return slugToPath(idToSlug(id));
}

/**
 * Normalize a base directory + a relative path into a clean, repo-root-relative
 * POSIX path. Resolves "." and "..", drops empty segments. Pure string math so
 * it runs the same in node, the browser, and tests.
 */
export function normalizePath(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join("/");
}

// What to do with a link found in a wiki body:
//   internal — keep/point at a /wiki/ route (no new tab);
//   external — a real public URL (https:, mailto:, ...) — keep, open in a new tab;
//   redact   — the target is a non-public concept or an out-of-bundle file, so
//              DROP the link entirely (render its text only). Linking those to
//              GitHub source would still surface internal content, such as
//              contacts, financial operations, credentials, or working plans,
//              one click from the public wiki. The public render shows plain text.
export type WikiLinkKind = "internal" | "external" | "redact";

export interface ResolvedHref {
  /** the rewritten href (empty for redact) */
  href: string;
  kind: WikiLinkKind;
}

/**
 * Resolve a single anchor href found in a wiki page body.
 *
 * - same-page anchors and non-`.md` relative links -> internal, untouched;
 * - real external schemes (https:, mailto:, tel:, protocol-relative) -> external;
 * - a `.md` link is resolved relative to the source page and then:
 *     - a PUBLIC bundle concept -> its rendered /wiki/ route (internal);
 *     - a bundle index ("index" or ".../index") -> landing / section anchor (internal);
 *     - anything else (non-public concept, or a file outside the bundle) -> redact.
 */
export function resolveWikiHref(
  rawHref: string,
  fromId: string,
  publicIds: Set<string> | Iterable<string>,
  opts?: { wikiDir?: string },
): ResolvedHref {
  const wikiDir = opts?.wikiDir ?? WIKI_DIR_IN_REPO;
  const publics = publicIds instanceof Set ? publicIds : new Set(publicIds);

  const href = rawHref.trim();

  // Empty or pure same-page anchor: leave alone.
  if (href === "" || href.startsWith("#")) return { href, kind: "internal" };

  // Absolute scheme (https:, mailto:, tel:, ...) or protocol-relative: external.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    return { href, kind: "external" };
  }

  // Split off any #fragment or ?query so it can be re-appended after rewriting.
  const tailIdx = href.search(/[#?]/);
  const path = tailIdx === -1 ? href : href.slice(0, tailIdx);
  const tail = tailIdx === -1 ? "" : href.slice(tailIdx);

  // Only `.md` links get rewritten; other relative links pass through unchanged.
  if (!path.toLowerCase().endsWith(".md")) return { href, kind: "internal" };

  const repoBaseDir = [wikiDir, dirOf(fromId)].filter(Boolean).join("/");
  const repoTarget = normalizePath(repoBaseDir, path); // e.g. "wiki/org/nj-pbs.md" or "docs/x.md"

  const wikiPrefix = wikiDir + "/";
  if (repoTarget.startsWith(wikiPrefix)) {
    const targetId = repoTarget.slice(wikiPrefix.length).replace(/\.md$/i, "");
    if (targetId === "index") return { href: slugToPath("") + tail, kind: "internal" };
    if (targetId.endsWith("/index")) {
      const section = targetId.slice(0, -"/index".length);
      return { href: `${slugToPath("")}#${section}`, kind: "internal" };
    }
    if (publics.has(targetId)) return { href: idToPath(targetId) + tail, kind: "internal" };
  }

  // Non-public bundle concept, or a file outside the bundle: drop the link.
  return { href: "", kind: "redact" };
}

export interface WikiSection {
  dir: string;
  label: string;
  blurb: string;
}

// Section order + copy for the landing hub and the sidebar. Only sections that
// actually have public pages are shown (see groupPublicPages).
export const WIKI_SECTIONS: WikiSection[] = [
  {
    dir: "org",
    label: "Organizations and transition",
    blurb:
      "Public records about NJ PBS, its operators, and the 2026 transition.",
  },
  {
    dir: "people",
    label: "People",
    blurb: "Publicly documented people connected to NJ PBS and its operators.",
  },
  {
    dir: "timeline",
    label: "Timeline",
    blurb: "Selected public milestones in the 2026 operator transition.",
  },
];

export interface WikiPageMeta {
  id: string;
  slug: string;
  path: string;
  title: string;
  description: string;
  type?: string;
}

/** Group public concept pages by section, in WIKI_SECTIONS order, dropping empty sections. */
export function groupPublicPages(
  pages: WikiPageMeta[],
): { section: WikiSection; pages: WikiPageMeta[] }[] {
  return WIKI_SECTIONS.map((section) => ({
    section,
    pages: pages
      .filter(
        (p) =>
          dirOf(p.id) === section.dir &&
          p.id !== "index" &&
          !p.id.endsWith("/index"),
      )
      .sort((a, b) => a.title.localeCompare(b.title)),
  })).filter((g) => g.pages.length > 0);
}
