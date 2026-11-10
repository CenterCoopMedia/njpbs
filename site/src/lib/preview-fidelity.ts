// Preview fidelity: one render path, two content sources.
//
// Static and preview routes derive the same page view and render it through the
// same renderer from a ResolvedPage. Each route resolves its own source; this
// dependency-free module imports no astro:content and is testable independently.

export type PageKind = "fallback" | "article";

/**
 * A fallback page's call-to-action button. `external` mirrors the content flag
 * `PublicSubpage` reads; combined with an http(s) href it opens the link in a new
 * tab (`opensInNewTab` at `PublicSubpage.astro:76`), which adds `target`, `rel`,
 * and a screen-reader "opens in new tab" cue to the real markup. Modeled here so
 * that state is part of what the parity renderer reflects.
 */
export interface CtaAction {
  label: string;
  href: string;
  external?: boolean;
}

/**
 * Fields every page source must resolve, whether the page is an article or a
 * launch fallback. The discriminated variants below carry the component-specific
 * contract that the real public renderer requires.
 */
interface ResolvedPageBase {
  slug: string;
  title?: string;
  description?: string;
  /**
   * The page's public canonical path, authored once and identical on preview and
   * publish (for example `/give/` for donate). Carried explicitly because
   * `Base.astro:25` falls back an undefined canonical to `Astro.url.pathname`, so
   * a preview route that left it undefined would emit `/preview/<slug>/` as its
   * canonical and OG url while publish emits `/<slug>/` -- exactly the divergence
   * this design forbids. The source resolves it, not the request.
   */
  canonicalPath: string;
  /**
   * Rendered content HTML: the article body (the content-collection render
   * output) or the fallback page's rendered content blocks. Carried for both
   * kinds so the renderer is a function of the body for both, not just articles.
   */
  body?: string;
  noindex?: boolean;
  /**
   * Publication state, mirroring the content schema's `draft` flag
   * (`content.config.ts`, default true). `publishedSource` refuses drafts, so the
   * static build cannot carry an unpublished page even if one is handed to it.
   */
  draft?: boolean;
}

/**
 * An article renders through `PublicArticle` and has no launch CTA contract.
 * Keeping the CTA fields unavailable prevents an adapter from silently handing
 * article-only data to the fallback component.
 */
export interface ResolvedArticlePage extends ResolvedPageBase {
  kind: "article";
  primaryAction?: never;
  secondaryAction?: never;
}

/**
 * A launch fallback renders through `PublicSubpage`, which dereferences its
 * primary action throughout the component. Requiring it at the type boundary
 * makes a missing CTA an adapter compile error instead of a public-page crash.
 */
export interface ResolvedFallbackPage extends ResolvedPageBase {
  kind: "fallback";
  primaryAction: CtaAction;
  secondaryAction?: CtaAction;
}

/**
 * A page resolved from committed content or a draft. The discriminant replaces
 * the old `page | entry` split while preserving the real component contracts.
 */
export type ResolvedPage = ResolvedArticlePage | ResolvedFallbackPage;

/** The head/layout props the page renders. Mirrors what [...slug].astro derives. */
export interface PageView {
  title: string;
  description: string;
  /** Always the page's public canonical, so preview and publish never differ. */
  canonicalPath: string;
  noindex: boolean;
  /**
   * The fallback launch CTAs, carried through from the source so a subpage's
   * calls to action are part of the content the renderer reflects. Undefined only
   * for articles; every fallback requires a primary action.
   */
  primaryAction?: CtaAction;
  secondaryAction?: CtaAction;
  /** Chrome-only flag: a preview banner and forced noindex. Never content. */
  preview: boolean;
  component: "PublicSubpage" | "PublicArticle";
}

const DEFAULT_TITLE = "NJ PBS";

/**
 * The one additive marker that preview chrome brackets the rendered document
 * with. It is the single source of truth: `renderPage` writes it, and the parity
 * guards below strip it through `stripPreviewChrome`, so preview and publish HTML
 * are compared on content alone. Kept as a constant rather than a bare `"[preview]"`
 * literal because both the writer and every stripper must agree on it; a hardcoded
 * copy that drifts would let a parity check silently pass while comparing the wrong
 * bytes.
 */
export const PREVIEW_CHROME_MARKER = "[preview]";

/**
 * Derive the layout props from a resolved page. This is the single derivation the
 * static build and the preview route share. `preview` is chrome only: it forces
 * noindex (a preview must never be indexable) and flags the banner, and it changes
 * nothing else, so a preview and a publish of the same content differ only in
 * chrome.
 */
export function resolvePageView(
  page: ResolvedPage,
  opts: { preview: boolean },
): PageView {
  return {
    title: page.title ?? DEFAULT_TITLE,
    description: page.description ?? DEFAULT_TITLE,
    // Carry the source's public canonical unchanged; never derive it from the
    // request path, so the preview and published canonical/OG url match.
    canonicalPath: page.canonicalPath,
    // A preview is never indexable, regardless of the page's own noindex.
    noindex: opts.preview ? true : (page.noindex ?? false),
    // Carry both CTAs through as content, so a fallback's calls to action are
    // part of what the shared renderer reflects.
    primaryAction: page.primaryAction,
    secondaryAction: page.secondaryAction,
    preview: opts.preview,
    component: page.kind === "article" ? "PublicArticle" : "PublicSubpage",
  };
}

/** The content-facing view: everything an approver reviews, minus preview chrome. */
export type ContentView = Omit<PageView, "preview" | "noindex">;

/** Strip the preview-only chrome so two views can be compared for content parity. */
export function contentView(view: PageView): ContentView {
  return {
    title: view.title,
    description: view.description,
    canonicalPath: view.canonicalPath,
    primaryAction: view.primaryAction,
    secondaryAction: view.secondaryAction,
    component: view.component,
  };
}

/**
 * A source of resolved pages. The static build is backed by committed content; the
 * preview route by draft state. Same return type, so the renderer cannot diverge.
 */
export interface PageSource {
  read(slug: string): ResolvedPage | null;
}

/**
 * Published source: committed content that is explicitly published only. The
 * filter is the invariant, not a caller's responsibility: a page reaches the
 * static build only when `draft` is exactly `false`. This fails closed, because
 * the content schema defaults `draft` to true (`content.config.ts`), so a page
 * whose draft flag was omitted or left undefined (an adapter that forgot to
 * thread it through) is treated as unpublished, not accidentally published. An
 * unpublished page can never bake into the public site.
 */
export function publishedSource(pages: readonly ResolvedPage[]): PageSource {
  const bySlug = new Map(
    pages.filter((p) => p.draft === false).map((p) => [p.slug, p]),
  );
  return { read: (slug) => bySlug.get(slug) ?? null };
}

export interface PreviewToken {
  token: string;
  /**
   * The single draft slug this token authorizes. A token is scoped to one page,
   * so a reviewer holding a token for one draft cannot read another by swapping
   * the slug in the url.
   */
  slug: string;
  /** Epoch ms after which the token is dead. */
  expiresAt: number;
}

/**
 * Authorize a preview request. Fail-closed: a missing record, a mismatched token,
 * a non-finite clock, a non-finite expiry, or an expired token all deny. An
 * unpublished draft can only be read through a source gated on this returning
 * true. Both sides of the clock comparison are guarded because the record comes
 * from the draft store at runtime, not a TypeScript literal, so a corrupt
 * `expiresAt` of `Infinity` must not mint a token that never expires.
 */
export function authorizePreview(
  presented: string,
  record: PreviewToken | null,
  now: number,
): boolean {
  if (!record) return false;
  if (presented !== record.token) return false;
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(record.expiresAt)) return false;
  return now < record.expiresAt;
}

/**
 * Draft source: draft content, readable only when the token authorizes. Without a
 * valid token every read returns null, so the preview route leaks nothing when the
 * token is missing or expired.
 */
export function draftSource(
  drafts: readonly ResolvedPage[],
  presented: string,
  record: PreviewToken | null,
  now: number,
): PageSource {
  const authorized = authorizePreview(presented, record, now);
  const bySlug = new Map(drafts.map((p) => [p.slug, p]));
  // Bind the read to the token's own slug: a valid token reads only the one draft
  // it was issued for, never another draft by requesting a different slug.
  return {
    read: (slug) =>
      authorized && record?.slug === slug ? (bySlug.get(slug) ?? null) : null,
  };
}

/**
 * Whether a CTA opens in a new tab, mirroring `PublicSubpage.astro:76`: an
 * external flag AND an http(s) href. Only then does the real markup add
 * `target`, `rel`, and the screen-reader new-tab cue, so the model gates those on
 * the same condition.
 */
function opensInNewTab(action: CtaAction): boolean {
  return action.external === true && /^https?:\/\//.test(action.href);
}

/**
 * Serialize a CTA the way `PublicSubpage` renders one: href and label always, plus
 * the new-tab attributes and the screen-reader cue when it opens in a new tab. A
 * change to the label, href, or external state therefore moves the output.
 */
function renderCta(action: CtaAction): string {
  const newTab = opensInNewTab(action);
  const attrs = newTab ? ` target="_blank" rel="noopener"` : "";
  const cue = newTab ? "<sr> (opens in new tab)</sr>" : "";
  return `<cta href="${action.href}"${attrs}>${action.label}${cue}</cta>`;
}

/**
 * The one renderer, modeled as a pure function of (view, body). The real renderer
 * is PublicSiteLayout + PublicSubpage/PublicArticle; this stand-in captures the
 * property that matters for fidelity: output is a function of every authored prop
 * the real layout emits, so equal content yields equal output and a change to any
 * of those props moves it. That covers the head props Base.astro writes into the
 * document and Open Graph/Twitter meta (title, description, canonical) and, for a
 * subpage, both CTAs with their new-tab state. Preview chrome is additive and
 * bracketed, never woven into the content.
 */
export function renderPage(view: PageView, body: string | undefined): string {
  const chrome = view.preview ? PREVIEW_CHROME_MARKER : "";
  const primary = view.primaryAction ? renderCta(view.primaryAction) : "";
  const secondary = view.secondaryAction ? renderCta(view.secondaryAction) : "";
  // Both kinds render as a function of their content: an article is its body; a
  // fallback is its title, both CTAs, and rendered blocks.
  const main =
    view.component === "PublicArticle"
      ? (body ?? "")
      : `fallback:${view.title}${primary}${secondary}${body ?? ""}`;
  return `${chrome}<title>${view.title}</title><description>${view.description}</description><canonical>${view.canonicalPath}</canonical><main>${main}</main>`;
}

/**
 * Render a slug through a source. This is the shared entrypoint: the static build
 * calls it with the published source and preview=false; the preview route with the
 * draft source and preview=true. Returns null when the source has no such page.
 */
export function renderFromSource(
  source: PageSource,
  slug: string,
  opts: { preview: boolean },
): string | null {
  const page = source.read(slug);
  if (!page) return null;
  return renderPage(resolvePageView(page, opts), page.body);
}

/**
 * The design contract the preview route must honor: it is server-rendered, never
 * prerendered, so drafts are never baked into the static output. Asserted in the
 * suite and referenced by the route adapter when it is written.
 */
export const PREVIEW_ROUTE_PRERENDER = false;

/**
 * Strip the additive preview chrome from a rendered document so a preview and a
 * publish can be compared on content alone. Chrome is a single leading marker, so
 * removing it leaves exactly the published bytes. Uses {@link PREVIEW_CHROME_MARKER}
 * rather than a hardcoded literal, so the writer and this stripper can never drift
 * apart. A publish render (no chrome) passes through unchanged.
 */
export function stripPreviewChrome(html: string): string {
  return html.startsWith(PREVIEW_CHROME_MARKER)
    ? html.slice(PREVIEW_CHROME_MARKER.length)
    : html;
}

/**
 * The acceptance criterion at the content level: for one resolved page, the props
 * a reviewer approves in preview are identical to the props publish emits. Preview
 * and publish share {@link resolvePageView} and differ only in chrome, so their
 * {@link contentView}s must be equal. Returns true when they agree. The route
 * adapter can assert this before rendering, and the suite pins it, so "the reviewer
 * approves against the rendered draft, not a separate approximation" is enforced,
 * not assumed.
 */
export function previewMatchesPublish(page: ResolvedPage): boolean {
  const preview = contentView(resolvePageView(page, { preview: true }));
  const publish = contentView(resolvePageView(page, { preview: false }));
  // Structural compare via serialization is safe here, not brittle: both sides
  // are built by the same `contentView` with a fixed literal key order, and every
  // field is carried through from the same `page` reference, so the two objects
  // serialize deterministically and key order can never differ between them.
  return JSON.stringify(preview) === JSON.stringify(publish);
}

/**
 * The acceptance criterion at the output level, and the strongest form of "the
 * preview is identical to the published page for the same draft": render the same
 * resolved page through the one renderer in both modes, strip the preview chrome,
 * and require the remaining document to be byte-identical. This proves the render
 * path itself cannot diverge — the mechanically enforceable half of "preview can
 * never diverge from publish." (It does not, and cannot, assert that a draft equals
 * what is committed; that is a publish action, not a rendering property.)
 */
export function renderedPreviewMatchesPublish(page: ResolvedPage): boolean {
  const publish = renderPage(resolvePageView(page, { preview: false }), page.body);
  const preview = renderPage(resolvePageView(page, { preview: true }), page.body);
  return stripPreviewChrome(preview) === publish;
}
