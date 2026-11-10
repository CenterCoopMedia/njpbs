import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { Link, useLocation, useNavigationType, useParams } from "react-router";
import { InlineMessage } from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import {
  GUIDE_SEARCH_PASSAGE_LIMIT,
  GUIDE_SEARCH_TEXT_LIMIT,
} from "../lib/guide-video-assets";
import { ensureGuideVideoWorker, listenForGuideVideoToken } from "../lib/guide-video-worker";
import { GuidePlaybackProvider, GuideVideo, type GuidePlayback } from "./GuideVideo";
import { useShell } from "./ShellContext";
import "./BoardwalkGuideRoute.css";

interface GuidePage {
  slug: string;
  title: string;
  description: string;
  audience: string;
}

interface GuideSection {
  id: string;
  title: string;
  description: string;
  pages: GuidePage[];
}

interface GuideManifest {
  sections: GuideSection[];
}

interface GuideSearchPassage {
  url: string;
  title: string;
  text: string;
}

const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GUIDE_IMAGE = /^\/images\/admin-guide\/([A-Za-z0-9][A-Za-z0-9._-]*\.webp)$/;
const GUIDE_PATH = /^\/guide-content\/(?:manifest\.json|search\.json|pages\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|images\/[A-Za-z0-9][A-Za-z0-9._-]*\.webp)$/;
const GUIDE_SEARCH_URL = /^\/guide\/[a-z0-9]+(?:-[a-z0-9]+)*(?:#[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

const guideSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details",
    "figcaption",
    "figure",
    "kbd",
    "summary",
    "track",
    "video",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      ["className", /^admin-docs-/, "sr-only"],
    ],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      "ariaLabel",
      "rel",
      "target",
    ],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "decoding",
      "height",
      "loading",
      "width",
    ],
    track: ["default", "kind", "label", "src", "srcLang"],
    video: [
      "ariaLabel",
      "controls",
      "height",
      "playsInline",
      "poster",
      "preload",
      "src",
      "width",
    ],
  },
};

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function parseGuideManifest(value: unknown): GuideManifest {
  if (!value || typeof value !== "object" || !Array.isArray((value as { sections?: unknown }).sections)) {
    throw new Error("The guide index is invalid.");
  }
  const sections = (value as { sections: unknown[] }).sections;
  if (sections.length === 0 || sections.length > 12) throw new Error("The guide index is invalid.");
  const slugs = new Set<string>();
  const parsed = sections.map((section): GuideSection => {
    if (!section || typeof section !== "object") throw new Error("The guide index is invalid.");
    const candidate = section as Record<string, unknown>;
    if (
      !boundedString(candidate.id, 80) ||
      !GUIDE_SLUG.test(candidate.id) ||
      !boundedString(candidate.title, 120) ||
      !boundedString(candidate.description, 400) ||
      !Array.isArray(candidate.pages) ||
      candidate.pages.length === 0 ||
      candidate.pages.length > 30
    ) {
      throw new Error("The guide index is invalid.");
    }
    const pages = candidate.pages.map((page): GuidePage => {
      if (!page || typeof page !== "object") throw new Error("The guide index is invalid.");
      const item = page as Record<string, unknown>;
      if (
        !boundedString(item.slug, 100) ||
        !GUIDE_SLUG.test(item.slug) ||
        slugs.has(item.slug) ||
        !boundedString(item.title, 160) ||
        !boundedString(item.description, 500) ||
        !boundedString(item.audience, 160)
      ) {
        throw new Error("The guide index is invalid.");
      }
      slugs.add(item.slug);
      return {
        slug: item.slug,
        title: item.title,
        description: item.description,
        audience: item.audience,
      };
    });
    return {
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      pages,
    };
  });
  return { sections: parsed };
}

export function parseGuideSearch(value: unknown): GuideSearchPassage[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { passages?: unknown }).passages)) {
    throw new Error("The guide search index is invalid.");
  }
  const passages = (value as { passages: unknown[] }).passages;
  if (passages.length === 0 || passages.length > GUIDE_SEARCH_PASSAGE_LIMIT) {
    throw new Error("The guide search index is invalid.");
  }
  return passages.map((passage) => {
    if (!passage || typeof passage !== "object") throw new Error("The guide search index is invalid.");
    const candidate = passage as Record<string, unknown>;
    if (
      !boundedString(candidate.url, 220) ||
      !GUIDE_SEARCH_URL.test(candidate.url) ||
      !boundedString(candidate.title, 320) ||
      !boundedString(candidate.text, GUIDE_SEARCH_TEXT_LIMIT)
    ) {
      throw new Error("The guide search index is invalid.");
    }
    return {
      url: candidate.url,
      title: candidate.title,
      text: candidate.text,
    };
  });
}

async function privateGuideResponse(
  path: string,
  getIdToken: () => Promise<string>,
  signal?: AbortSignal,
): Promise<Response> {
  if (!GUIDE_PATH.test(path)) throw new Error("The guide path is invalid.");
  const token = await getIdToken();
  const response = await fetch(path, {
    cache: "no-store",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`The guide request failed (${response.status}).`);
  return response;
}

class GuideAssetResolver {
  private readonly values = new Map<string, Promise<string>>();
  private readonly states = new Map<string, { url?: string; error: boolean }>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly objectUrls = new Set<string>();

  constructor(private readonly getIdToken: () => Promise<string>) {}

  resolve(source: string): Promise<string> {
    const match = source.match(GUIDE_IMAGE);
    if (!match) return Promise.reject(new Error("The guide image path is invalid."));
    const existing = this.values.get(source);
    if (existing) return existing;
    const value = privateGuideResponse(
      `/guide-content/images/${match[1]}`,
      this.getIdToken,
    ).then(async (response) => {
      const objectUrl = URL.createObjectURL(await response.blob());
      this.objectUrls.add(objectUrl);
      this.states.set(source, { url: objectUrl, error: false });
      this.notify(source);
      return objectUrl;
    }).catch((error: unknown) => {
      this.states.set(source, { error: true });
      this.notify(source);
      throw error;
    });
    this.values.set(source, value);
    return value;
  }

  read(source: string) {
    return this.states.get(source) ?? { error: false };
  }

  subscribe(source: string, listener: () => void) {
    const listeners = this.listeners.get(source) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(source, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(source);
    };
  }

  private notify(source: string) {
    for (const listener of this.listeners.get(source) ?? []) listener();
  }

  dispose() {
    for (const objectUrl of this.objectUrls) URL.revokeObjectURL(objectUrl);
    this.objectUrls.clear();
    this.listeners.clear();
    this.states.clear();
    this.values.clear();
  }
}

const GuideAssetContext = createContext<GuideAssetResolver | null>(null);

function useGuideAsset(
  source: string | undefined,
  load = true,
): { url?: string; error: boolean } {
  const resolver = useContext(GuideAssetContext);
  const [state, setState] = useState<{ source?: string; url?: string; error: boolean }>({ error: false });
  useEffect(() => {
    if (!source || !resolver || !GUIDE_IMAGE.test(source)) {
      setState({ source, error: Boolean(source) });
      return;
    }
    const update = () => setState({ source, ...resolver.read(source) });
    const unsubscribe = resolver.subscribe(source, update);
    update();
    if (load) void resolver.resolve(source).catch(() => undefined);
    return unsubscribe;
  }, [load, resolver, source]);
  return state.source === source ? state : { error: false };
}

const GuideImage: NonNullable<Components["img"]> = ({ src, alt, loading, node: _node, ...props }) => {
  const imageRef = useRef<HTMLImageElement>(null);
  const [visibleSource, setVisibleSource] = useState<string>();

  useEffect(() => {
    if (!src || loading !== "lazy") return;
    const image = imageRef.current;
    if (!image || typeof IntersectionObserver === "undefined") {
      setVisibleSource(src);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisibleSource(src);
      observer.disconnect();
    }, { rootMargin: "300px 0px" });
    observer.observe(image);
    return () => observer.disconnect();
  }, [loading, src]);

  const asset = useGuideAsset(src, loading !== "lazy" || visibleSource === src);
  if (asset.error) return <span className="admin-guide-image-error">Screenshot unavailable.</span>;
  return (
    <img
      {...props}
      alt={alt ?? ""}
      aria-busy={!asset.url}
      loading={loading}
      ref={imageRef}
      src={asset.url}
    />
  );
};

function guideHref(href: string, slug: string): string {
  if (/^https:\/\/dev-public\.example\.org\/admin\/docs(?:\/|$)/.test(href)) {
    const source = new URL(href);
    return `/guide/${source.pathname.replace(/^\/admin\/docs\/?/, "")}${source.hash}`;
  }
  if (href.startsWith("../") || href.startsWith("./")) {
    const resolved = new URL(href, `https://admin.njpbs.org/guide/${slug}/`);
    return `${resolved.pathname}${resolved.hash}`;
  }
  return href;
}

function guideComponents(slug: string): Components {
  const GuideAnchor: NonNullable<Components["a"]> = ({ href, children, node: _node, ...props }) => {
    const asset = useGuideAsset(href, false);
    if (href && GUIDE_IMAGE.test(href)) {
      return asset.url ? <a {...props} href={asset.url}>{children}</a> : <span>{children}</span>;
    }
    const normalized = href ? guideHref(href, slug) : "";
    if (normalized.startsWith("/guide/") || normalized.startsWith("#")) {
      return <Link to={normalized}>{children}</Link>;
    }
    return <a {...props} href={defaultUrlTransform(normalized)}>{children}</a>;
  };
  const GuideVideoBlock: NonNullable<Components["video"]> = ({ src, node: _node, ...props }) => {
    const record = props as { ariaLabel?: string; "aria-label"?: string };
    return (
      <GuideVideo
        label={record.ariaLabel ?? record["aria-label"]}
        src={typeof src === "string" ? src : undefined}
      />
    );
  };
  return {
    a: GuideAnchor,
    img: GuideImage,
    video: GuideVideoBlock,
    h2: ({ node: _node, ...props }) => <h3 {...props} />,
    h3: ({ node: _node, ...props }) => <h4 {...props} />,
    h4: ({ node: _node, ...props }) => <h5 {...props} />,
  };
}

function GuideNavigation({ manifest, current }: { manifest: GuideManifest; current?: string }) {
  return (
    <nav aria-label="Boardwalk guide">
      <Link
        aria-current={!current ? "page" : undefined}
        className={!current ? "current" : undefined}
        to="/guide"
      >
        Guide home
      </Link>
      {manifest.sections.map((section) => (
        <section key={section.id}>
          <p className="admin-guide-nav-title">{section.title}</p>
          <ul>
            {section.pages.map((page) => (
              <li key={page.slug}>
                <Link aria-current={current === page.slug ? "page" : undefined} to={`/guide/${page.slug}`}>
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function searchExcerpt(text: string, terms: string[]): string {
  const lower = text.toLocaleLowerCase();
  const first = Math.min(
    ...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0),
  );
  let start = Number.isFinite(first) ? Math.max(0, first - 70) : 0;
  if (start > 0) {
    const nextWord = text.indexOf(" ", start);
    start = nextWord >= 0 ? nextWord + 1 : 0;
  }
  let end = Math.min(text.length, start + 220);
  if (end < text.length) {
    const lastWord = text.lastIndexOf(" ", end);
    if (lastWord > start) end = lastWord;
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function GuideSearch({ load }: {
  load: (path: string, signal?: AbortSignal) => Promise<Response>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GuideSearchPassage[]>([]);
  const [status, setStatus] = useState("Enter words or a phrase to search the guide.");
  const indexRef = useRef<Promise<GuideSearchPassage[]> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const revisionRef = useRef(0);
  const location = useLocation();

  const closeSearch = useCallback((restoreFocus = false) => {
    revisionRef.current += 1;
    setQuery("");
    setResults([]);
    setStatus("Enter words or a phrase to search the guide.");
    if (restoreFocus) inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(async (value: string) => {
    const revision = ++revisionRef.current;
    const terms = value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      setResults([]);
      setStatus("Enter words or a phrase to search the guide.");
      return;
    }
    setStatus("Searching the guide…");
    indexRef.current ??= load("/guide-content/search.json")
      .then((response) => response.json())
      .then(parseGuideSearch);
    try {
      const passages = await indexRef.current;
      if (revision !== revisionRef.current) return;
      const groups = new Map<string, GuideSearchPassage[]>();
      for (const passage of passages) {
        const group = groups.get(passage.url) ?? [];
        group.push(passage);
        groups.set(passage.url, group);
      }
      const scored = [...groups.values()].flatMap((group) => {
        const matched = terms.every((term) => group.some((passage) => {
          const title = passage.title.toLocaleLowerCase();
          const text = passage.text.toLocaleLowerCase();
          return title.includes(term) || text.includes(term);
        }));
        if (!matched) return [];
        const best = group.reduce((current, passage) => {
          const title = passage.title.toLocaleLowerCase();
          const text = passage.text.toLocaleLowerCase();
          const score = terms.reduce(
            (total, term) => total + (title.includes(term) ? 3 : 0) + (text.includes(term) ? 1 : 0),
            0,
          );
          return score > current.score ? { passage, score } : current;
        }, { passage: group[0], score: -1 });
        return [best];
      });
      const matches = scored
        .sort((left, right) => right.score - left.score || left.passage.title.localeCompare(right.passage.title))
        .slice(0, 8)
        .map(({ passage }) => passage);
      setResults(matches);
      setStatus(matches.length ? `${matches.length} matching sections.` : "No matching sections. Try different words.");
    } catch {
      if (revision !== revisionRef.current) return;
      indexRef.current = null;
      setResults([]);
      setStatus("Guide search is unavailable. Browse the guide below.");
    }
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void runSearch(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => () => { revisionRef.current += 1; }, []);

  useEffect(() => {
    closeSearch();
  }, [closeSearch, location.hash, location.pathname]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    closeSearch(true);
  };

  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return (
    <section
      className="admin-guide-search"
      aria-label="Search the Boardwalk guide"
      onKeyDown={onKeyDown}
    >
      <form
        role="search"
        aria-label="Boardwalk guide search"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query.trim());
        }}
      >
        <label className="sr-only" htmlFor="guide-search-query">Search the guide</label>
        <input
          aria-controls="guide-search-results"
          autoComplete="off"
          id="guide-search-query"
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the guide"
          ref={inputRef}
          type="search"
          value={query}
        />
      </form>
      <div className="admin-guide-search-results" id="guide-search-results" hidden={!query.trim()}>
        <p role="status" aria-live="polite">{status}</p>
        {results.length > 0 ? (
          <ol aria-label="Guide search results">
            {results.map((result) => (
              <li key={result.url}>
                <Link onClick={() => closeSearch()} to={result.url}>{result.title}</Link>
                <p>{searchExcerpt(result.text, terms)}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

function GuideIndex({ manifest }: { manifest: GuideManifest }) {
  return (
    <article className="admin-guide-article admin-guide-index">
      <header>
        <h2>Instructions for Boardwalk</h2>
        <p>Find the current steps for creating, reviewing, and maintaining NJ PBS content.</p>
      </header>
      {manifest.sections.map((section) => (
        <section key={section.id}>
          <h3>{section.title}</h3>
          <p>{section.description}</p>
          <ul>
            {section.pages.map((page) => (
              <li key={page.slug}>
                <Link to={`/guide/${page.slug}`}>
                  <span>
                    <strong>{page.title}</strong>
                    {page.description}
                  </span>
                  <span className="admin-guide-audience">{page.audience}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

function GuidePageView({ page, markdown }: { page: GuidePage; markdown: string }) {
  return (
    <article className="admin-guide-article">
      <header>
        <h2 data-route-focus-heading>{page.title}</h2>
        <p>{page.description}</p>
      </header>
      <div className="admin-guide-prose">
        <ReactMarkdown
          components={guideComponents(page.slug)}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, guideSchema], rehypeSlug]}
          remarkPlugins={[remarkGfm]}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </article>
  );
}

function GuideFrame({ children, manifest, current, search }: {
  children: ReactNode;
  manifest: GuideManifest;
  current?: string;
  search: ReactNode;
}) {
  const location = useLocation();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  useEffect(() => setMobileNavigationOpen(false), [location.hash, location.pathname]);

  return (
    <div className="admin-guide-route">
      {search}
      <details
        className="admin-guide-mobile-nav"
        onToggle={(event) => setMobileNavigationOpen(event.currentTarget.open)}
        open={mobileNavigationOpen}
      >
        <summary>Guide topics</summary>
        <GuideNavigation current={current} manifest={manifest} />
      </details>
      <div className="admin-guide-frame">
        <aside className="admin-guide-sidebar">
          <GuideNavigation current={current} manifest={manifest} />
        </aside>
        <div className="admin-guide-main">{children}</div>
      </div>
    </div>
  );
}

export function BoardwalkGuideRoute() {
  const { slug } = useParams<{ slug?: string }>();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { getIdToken } = useShell();
  const [manifest, setManifest] = useState<GuideManifest | null>(null);
  const [markdown, setMarkdown] = useState<{ slug: string; value: string } | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<{ slug: string; message: string } | null>(null);
  const [playback, setPlayback] = useState<GuidePlayback>("blob");
  const assetResolver = useMemo(
    () => getIdToken ? new GuideAssetResolver(getIdToken) : null,
    [getIdToken],
  );

  const load = useCallback(async (path: string, signal?: AbortSignal) => {
    if (!getIdToken) throw new Error("The signed-in session is unavailable.");
    return privateGuideResponse(path, getIdToken, signal);
  }, [getIdToken]);

  useEffect(() => () => assetResolver?.dispose(), [assetResolver]);

  useEffect(() => {
    if (!getIdToken) return undefined;
    let cancel = false;
    const stop = listenForGuideVideoToken(getIdToken);
    void ensureGuideVideoWorker().then((direct) => {
      if (!cancel && direct) setPlayback("direct");
    });
    return () => {
      cancel = true;
      stop();
    };
  }, [getIdToken]);

  useEffect(() => {
    const controller = new AbortController();
    setManifestError(null);
    void load("/guide-content/manifest.json", controller.signal)
      .then((response) => response.json())
      .then((value) => { if (!controller.signal.aborted) setManifest(parseGuideManifest(value)); })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setManifestError(loadError instanceof Error ? loadError.message : "The guide could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [load]);

  const page = manifest?.sections.flatMap((section) => section.pages)
    .find((candidate) => candidate.slug === slug);

  useEffect(() => {
    setPageError(null);
    if (!slug || !GUIDE_SLUG.test(slug) || !page) return;
    const controller = new AbortController();
    void load(`/guide-content/pages/${slug}.md`, controller.signal)
      .then((response) => response.text())
      .then((value) => { if (!controller.signal.aborted) setMarkdown({ slug, value }); })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setPageError({
            slug,
            message: loadError instanceof Error ? loadError.message : "The guide page could not be loaded.",
          });
        }
      });
    return () => controller.abort();
  }, [load, page, slug]);

  const currentPageError = pageError && pageError.slug === slug ? pageError.message : null;

  useEffect(() => {
    if (!manifest || (slug && page && markdown?.slug !== slug && !currentPageError)) return;
    const frame = window.requestAnimationFrame(() => {
      if (location.hash) {
        let targetId = location.hash.slice(1);
        try {
          targetId = decodeURIComponent(targetId);
        } catch {
          return;
        }
        document.getElementById(targetId)?.scrollIntoView({ block: "start" });
      } else if (navigationType !== "POP") {
        window.scrollTo({ top: 0 });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentPageError, location.hash, location.key, manifest, markdown, navigationType, page, slug]);

  if (manifestError) {
    return (
      <InlineMessage tone="error" title="Boardwalk guide unavailable">
        {manifestError} Try again after you refresh your session.
      </InlineMessage>
    );
  }
  if (!manifest) return <LoadingIndicator label="Opening the Boardwalk guide" />;
  if (slug && !page) {
    return (
      <GuideFrame
        current={slug}
        manifest={manifest}
        search={<GuideSearch load={load} />}
      >
        <InlineMessage tone="error" title="Guide page not found">
          Return to the <Link to="/guide">Boardwalk guide home</Link>.
        </InlineMessage>
      </GuideFrame>
    );
  }

  return (
    <GuideAssetContext.Provider value={assetResolver}>
      <GuidePlaybackProvider mode={playback}>
      <GuideFrame
        current={slug}
        manifest={manifest}
        search={<GuideSearch load={load} />}
      >
        {!slug ? <GuideIndex manifest={manifest} /> : currentPageError ? (
          <InlineMessage tone="error" title="Guide page unavailable">
            {currentPageError} Return to the <Link to="/guide">Boardwalk guide home</Link> or choose another topic.
          </InlineMessage>
        ) : page && markdown?.slug === slug ? (
          <GuidePageView markdown={markdown.value} page={page} />
        ) : page ? (
          <article className="admin-guide-article">
            <header>
              <h2 data-route-focus-heading>{page.title}</h2>
              <p>{page.description}</p>
            </header>
            <LoadingIndicator label="Opening this guide page" />
          </article>
        ) : (
          <LoadingIndicator label="Opening this guide page" />
        )}
      </GuideFrame>
      </GuidePlaybackProvider>
    </GuideAssetContext.Provider>
  );
}
