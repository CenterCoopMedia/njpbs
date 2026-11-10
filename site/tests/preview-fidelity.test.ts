import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  resolvePageView,
  contentView,
  publishedSource,
  draftSource,
  authorizePreview,
  renderPage,
  renderFromSource,
  PREVIEW_ROUTE_PRERENDER,
  PREVIEW_CHROME_MARKER,
  stripPreviewChrome,
  previewMatchesPublish,
  renderedPreviewMatchesPublish,
  type ResolvedPage,
  type PreviewToken,
} from "../src/lib/preview-fidelity";

// These prove the divergence-proof properties of the preview core (#203), not
// just line coverage: preview and publish share one derivation and one renderer,
// the published source can never carry a draft, and the draft token is
// fail-closed. Design: docs/research/preview-fidelity.md.

type ResolvedArticle = Extract<ResolvedPage, { kind: "article" }>;
type ResolvedFallback = Extract<ResolvedPage, { kind: "fallback" }>;

const article = (over: Partial<ResolvedArticle> = {}): ResolvedArticle => ({
  kind: "article",
  slug: "shows/example",
  title: "Example",
  description: "An example article.",
  canonicalPath: "/programs/example/",
  body: "<p>body</p>",
  noindex: false,
  draft: false,
  ...over,
});

const fallback = (over: Partial<ResolvedFallback> = {}): ResolvedFallback => ({
  kind: "fallback",
  slug: "about",
  title: "About",
  description: "About NJ PBS.",
  canonicalPath: "/about/",
  primaryAction: { label: "Learn about NJ PBS", href: "/about/" },
  draft: false,
  ...over,
});

describe("resolvePageView derivation parity with [...slug].astro", () => {
  it("falls back to NJ PBS for a missing title and description", () => {
    const view = resolvePageView(
      fallback({ title: undefined, description: undefined }),
      {
        preview: false,
      },
    );
    expect(view.title).toBe("NJ PBS");
    expect(view.description).toBe("NJ PBS");
  });

  it("carries the page's public canonical unchanged, never from the request path", () => {
    // Base.astro falls an undefined canonical back to Astro.url.pathname, so the
    // preview route must carry the real public canonical, not derive one.
    const donate = fallback({ slug: "donate", canonicalPath: "/give/" });
    expect(resolvePageView(donate, { preview: false }).canonicalPath).toBe(
      "/give/",
    );
    expect(resolvePageView(donate, { preview: true }).canonicalPath).toBe(
      "/give/",
    );
  });

  it("gives preview and publish the same canonical for the same page", () => {
    const page = article();
    expect(resolvePageView(page, { preview: true }).canonicalPath).toBe(
      resolvePageView(page, { preview: false }).canonicalPath,
    );
  });

  it("routes articles to PublicArticle and fallbacks to PublicSubpage", () => {
    expect(resolvePageView(article(), { preview: false }).component).toBe(
      "PublicArticle",
    );
    expect(resolvePageView(fallback(), { preview: false }).component).toBe(
      "PublicSubpage",
    );
  });

  it("defaults noindex to false when unset on a published render", () => {
    expect(
      resolvePageView(article({ noindex: undefined }), { preview: false })
        .noindex,
    ).toBe(false);
    expect(
      resolvePageView(article({ noindex: true }), { preview: false }).noindex,
    ).toBe(true);
  });
});

describe("preview differs from publish only in chrome", () => {
  it("yields identical content views for the same page", () => {
    const page = article();
    const published = resolvePageView(page, { preview: false });
    const preview = resolvePageView(page, { preview: true });
    expect(contentView(preview)).toEqual(contentView(published));
  });

  it("forces noindex on a preview even when the page is indexable", () => {
    const page = article({ noindex: false });
    expect(resolvePageView(page, { preview: true }).noindex).toBe(true);
    expect(resolvePageView(page, { preview: false }).noindex).toBe(false);
  });

  it("sets the preview flag only in preview mode", () => {
    const page = fallback();
    expect(resolvePageView(page, { preview: true }).preview).toBe(true);
    expect(resolvePageView(page, { preview: false }).preview).toBe(false);
  });
});

describe("one renderer: equal content renders equal, minus chrome", () => {
  it("published and preview render the same content between the chrome", () => {
    const page = article();
    const published = renderPage(
      resolvePageView(page, { preview: false }),
      page.body,
    );
    const preview = renderPage(
      resolvePageView(page, { preview: true }),
      page.body,
    );
    // The preview differs only by a leading marker; strip it through the shared
    // helper and the rendered document is byte-identical.
    expect(stripPreviewChrome(preview)).toBe(published);
  });

  it("a changed draft renders differently (preview shows the draft)", () => {
    const publishedPage = article({ title: "Old" });
    const draftPage = article({ title: "New" });
    const published = renderPage(
      resolvePageView(publishedPage, { preview: false }),
      publishedPage.body,
    );
    const preview = stripPreviewChrome(
      renderPage(resolvePageView(draftPage, { preview: true }), draftPage.body),
    );
    expect(preview).not.toBe(published);
    expect(preview).toContain("New");
  });

  it("a fallback CTA change moves the rendered output", () => {
    // The one-renderer parity must hold for subpages, not just articles: a
    // changed call to action has to change the derived output, or a preview
    // could match publish while the real CTA differs.
    const base = fallback({ primaryAction: { label: "Donate", href: "/give/" } });
    const changed = fallback({
      primaryAction: { label: "Donate now", href: "/give/" },
    });
    const view = (p: ResolvedPage) =>
      renderPage(resolvePageView(p, { preview: false }), p.body);
    expect(view(changed)).not.toBe(view(base));
    expect(view(base)).toContain("Donate");
  });

  it("a fallback body change moves the rendered output", () => {
    const base = fallback({ body: "<p>old</p>" });
    const changed = fallback({ body: "<p>new</p>" });
    const view = (p: ResolvedPage) =>
      renderPage(resolvePageView(p, { preview: false }), p.body);
    expect(view(changed)).not.toBe(view(base));
    expect(view(changed)).toContain("new");
  });

  it("a description-only change moves the rendered output", () => {
    // Base.astro writes description into the meta, og:description, and
    // twitter:description tags, so a description-only edit is an authored change
    // the reviewer must see reflected. The renderer has to carry it or parity
    // silently misses drift in the head props.
    const base = article({ description: "The old blurb." });
    const changed = article({ description: "The new blurb." });
    const view = (p: ResolvedPage) =>
      renderPage(resolvePageView(p, { preview: false }), p.body);
    expect(view(changed)).not.toBe(view(base));
    expect(view(changed)).toContain("The new blurb.");
  });

  it("a fallback secondary action change moves the rendered output", () => {
    // PublicSubpage renders a secondary CTA beside the primary, so a change to it
    // is a visible authored change that parity must catch.
    const primaryAction = { label: "Donate", href: "/give/" };
    const base = fallback({
      primaryAction,
      secondaryAction: { label: "Learn more", href: "/about/" },
    });
    const changed = fallback({
      primaryAction,
      secondaryAction: { label: "Learn more", href: "/support/" },
    });
    const view = (p: ResolvedPage) =>
      renderPage(resolvePageView(p, { preview: false }), p.body);
    expect(view(changed)).not.toBe(view(base));
    expect(view(base)).toContain("Learn more");
  });

  it("flipping a CTA to open in a new tab moves the rendered output", () => {
    // opensInNewTab (external + http href) adds target, rel, and a screen-reader
    // cue in the real markup, so flipping external must move the model output.
    const base = fallback({
      primaryAction: { label: "PBS app", href: "https://pbs.org/", external: false },
    });
    const changed = fallback({
      primaryAction: { label: "PBS app", href: "https://pbs.org/", external: true },
    });
    const view = (p: ResolvedPage) =>
      renderPage(resolvePageView(p, { preview: false }), p.body);
    expect(view(changed)).not.toBe(view(base));
    expect(view(changed)).toContain("opens in new tab");
    expect(view(base)).not.toContain("opens in new tab");
  });

  it("the new-tab state holds for the secondary CTA too, not just the primary", () => {
    // Both CTAs share renderCta, so the primary/secondary symmetry the model adds
    // has to prove out on the secondary action as well.
    const primaryAction = { label: "Donate", href: "/give/" };
    const base = fallback({
      primaryAction,
      secondaryAction: { label: "PBS app", href: "https://pbs.org/", external: false },
    });
    const changed = fallback({
      primaryAction,
      secondaryAction: { label: "PBS app", href: "https://pbs.org/", external: true },
    });
    const view = (p: ResolvedPage) =>
      renderPage(resolvePageView(p, { preview: false }), p.body);
    expect(view(changed)).not.toBe(view(base));
    expect(view(changed)).toContain("opens in new tab");
    expect(view(base)).not.toContain("opens in new tab");
  });
});

describe("sources: same shape, publish never carries drafts", () => {
  const token: PreviewToken = { token: "t-abc", slug: "s", expiresAt: 1_000 };

  it("published source returns committed pages and null for unknown", () => {
    const src = publishedSource([article({ slug: "a" })]);
    expect(src.read("a")?.slug).toBe("a");
    expect(src.read("missing")).toBeNull();
  });

  it("published source never returns an unpublished draft", () => {
    const published = publishedSource([article({ slug: "live" })]);
    // A draft-only page ('wip') is not in the published set, so the static build
    // cannot render it however hard it looks.
    expect(published.read("wip")).toBeNull();
  });

  it("published source filters out a draft even when it is handed one", () => {
    // The invariant lives in the source, not the caller: a draft: true page is
    // invisible to the static build without anyone remembering to filter.
    const published = publishedSource([
      article({ slug: "live", draft: false }),
      article({ slug: "wip", draft: true }),
    ]);
    expect(published.read("live")?.slug).toBe("live");
    expect(published.read("wip")).toBeNull();
  });

  it("published source fails closed when the draft flag is omitted", () => {
    // The content schema defaults draft to true, so a page whose flag an adapter
    // forgot to thread through (draft: undefined) is unpublished, not published.
    // Only an explicit draft: false publishes; the filter must not treat a
    // missing flag as "not a draft."
    const published = publishedSource([
      article({ slug: "shipped", draft: false }),
      article({ slug: "forgot", draft: undefined }),
    ]);
    expect(published.read("shipped")?.slug).toBe("shipped");
    expect(published.read("forgot")).toBeNull();
  });

  it("keeps every publicly allowlisted compliance page in the published source", () => {
    const complianceSlugs = ["privacy", "public-file", "eeo", "meeting-notices"];

    for (const slug of complianceSlugs) {
      const markdown = readFileSync(
        join(process.cwd(), "src", "content", "pages", `${slug}.md`),
        "utf8",
      );
      const draftFlag = markdown.match(/^draft:\s*(true|false)\s*$/m)?.[1];
      expect(
        draftFlag,
        `${slug} is publicly allowlisted and its frontmatter must say draft: false`,
      ).toBe("false");
      const page = article({ slug, draft: draftFlag === "true" });

      expect(
        publishedSource([page]).read(slug),
        `${slug} is publicly allowlisted and must carry draft: false`,
      ).toEqual(page);
    }
  });

  it("renderFromSource shares one path for publish and preview", () => {
    const page = article({ slug: "s", title: "Same" });
    const published = renderFromSource(publishedSource([page]), "s", {
      preview: false,
    });
    const preview = renderFromSource(
      draftSource([page], "t-abc", token, 500),
      "s",
      { preview: true },
    );
    expect(published).not.toBeNull();
    expect(stripPreviewChrome(preview ?? "")).toBe(published);
  });

  it("renderFromSource returns null when the slug is absent", () => {
    expect(
      renderFromSource(publishedSource([]), "nope", { preview: false }),
    ).toBeNull();
  });
});

describe("draft token authorization is fail-closed", () => {
  const token: PreviewToken = { token: "secret", slug: "wip", expiresAt: 1_000 };

  it("authorizes only a matching, unexpired token with a finite clock", () => {
    expect(authorizePreview("secret", token, 999)).toBe(true);
  });

  it("denies a missing record, wrong token, expiry, and a non-finite clock", () => {
    expect(authorizePreview("secret", null, 100)).toBe(false);
    expect(authorizePreview("wrong", token, 100)).toBe(false);
    expect(authorizePreview("secret", token, 1_000)).toBe(false); // at expiry
    expect(authorizePreview("secret", token, 2_000)).toBe(false); // past expiry
    expect(authorizePreview("secret", token, Number.NaN)).toBe(false);
  });

  it("denies a token whose stored expiry is not finite", () => {
    // The record comes from the draft store at runtime, so a corrupt
    // expiresAt of Infinity must not mint a token that never expires.
    const immortal: PreviewToken = { ...token, expiresAt: Number.POSITIVE_INFINITY };
    expect(authorizePreview("secret", immortal, 9_999_999)).toBe(false);
    const nan: PreviewToken = { ...token, expiresAt: Number.NaN };
    expect(authorizePreview("secret", nan, 100)).toBe(false);
  });

  it("draft source leaks nothing without a valid token", () => {
    const drafts = [article({ slug: "wip", title: "Unpublished" })];
    const denied = draftSource(drafts, "wrong", token, 500);
    expect(denied.read("wip")).toBeNull();
    const expired = draftSource(drafts, "secret", token, 5_000);
    expect(expired.read("wip")).toBeNull();
    const ok = draftSource(drafts, "secret", token, 500);
    expect(ok.read("wip")?.title).toBe("Unpublished");
  });

  it("a token bound to one slug cannot read another draft", () => {
    const drafts = [
      article({ slug: "wip", title: "Mine" }),
      article({ slug: "other", title: "Someone else's" }),
    ];
    // token.slug is 'wip'; a valid token must not read 'other' by swapping slugs.
    const src = draftSource(drafts, "secret", token, 500);
    expect(src.read("wip")?.title).toBe("Mine");
    expect(src.read("other")).toBeNull();
  });
});

describe("preview route is server-rendered, never prerendered", () => {
  it("declares prerender false so drafts never bake into the static site", () => {
    expect(PREVIEW_ROUTE_PRERENDER).toBe(false);
  });
});

describe("parity guards: the acceptance criterion as callable checks", () => {
  it("stripPreviewChrome removes the marker from a preview render", () => {
    const page = article();
    const preview = renderPage(resolvePageView(page, { preview: true }), page.body);
    expect(preview.startsWith(PREVIEW_CHROME_MARKER)).toBe(true);
    expect(stripPreviewChrome(preview).startsWith(PREVIEW_CHROME_MARKER)).toBe(false);
  });

  it("stripPreviewChrome leaves a publish render (no chrome) unchanged", () => {
    const page = article();
    const publish = renderPage(resolvePageView(page, { preview: false }), page.body);
    expect(stripPreviewChrome(publish)).toBe(publish);
  });

  it("previewMatchesPublish holds for an article and a fallback with both CTAs", () => {
    expect(previewMatchesPublish(article())).toBe(true);
    expect(
      previewMatchesPublish(
        fallback({
          primaryAction: { label: "Donate", href: "/give/" },
          secondaryAction: { label: "PBS app", href: "https://pbs.org/", external: true },
        }),
      ),
    ).toBe(true);
  });

  it("renderedPreviewMatchesPublish holds for articles and fallbacks", () => {
    expect(renderedPreviewMatchesPublish(article())).toBe(true);
    expect(
      renderedPreviewMatchesPublish(
        fallback({ primaryAction: { label: "Donate", href: "/give/" }, body: "<p>x</p>" }),
      ),
    ).toBe(true);
  });

  it("the guard is not vacuous: without stripping chrome, preview != publish", () => {
    // If the chrome marker were empty, renderedPreviewMatchesPublish would pass
    // trivially. Prove the strip is load-bearing: the raw preview render carries
    // chrome the publish render does not, so they differ before stripping.
    const page = article();
    const publish = renderPage(resolvePageView(page, { preview: false }), page.body);
    const rawPreview = renderPage(resolvePageView(page, { preview: true }), page.body);
    expect(rawPreview).not.toBe(publish);
    expect(stripPreviewChrome(rawPreview)).toBe(publish);
  });
});
