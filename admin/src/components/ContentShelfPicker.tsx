import { livePublishedSourceVersion } from "../lib/content-status";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ContentQuery } from "../lib/content-query";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import type { LibrarySelection } from "../lib/content-library";
import type { LoadedRecord } from "./EditorWorkspace";
import type { PageDirectoryEntry } from "./PagesDirectory";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";
import { PUBLIC_PAGES } from "../../../packages/content-core/src/public-pages";
import { isServerMintableSlugShape } from "../../../packages/content-core/src/post-slugs";
import { readPostLeadMedia, leadMediaAssetIds, leadMediaTitle } from "../../../packages/content-core/src/post-lead-media";
import { mintCollectionItemId } from "../lib/collection-item-keys";
import { Button, Select, TextInput } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import type { HomeHeroPin } from "../../../packages/content-core/src/home-hero";

export const ContentShelfSources = createContext<{
  loadLibrarySelection?: (query: ContentQuery) => Promise<LibrarySelection>;
  loadRecord?: (kind: RecordKind, id: string) => Promise<LoadedRecord>;
  loadPages?: () => Promise<PageDirectoryEntry[]>;
}>({});

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** A selected card is an editable copy; later source edits do not change a saved shelf. */
export function postShelfCard(record: Record<string, unknown>): Record<string, unknown> {
  const published = object(record.published);
  const liveVersion = livePublishedSourceVersion(record);
  if (record.deleted === true || record.publishBuildPending === true || liveVersion === null || published.sourceVersion !== liveVersion) {
    throw new Error("This post has no settled public snapshot. Try again after publication finishes.");
  }
  const metadata = object(published.metadata);
  if (!isServerMintableSlugShape(metadata.slug)) throw new Error("This post has no published destination.");
  const lead = readPostLeadMedia(metadata, true);
  const image = lead?.kind === "image" ? lead.data : null;
  return {
    itemId: mintCollectionItemId(), title: text(metadata.title),
    summary: text(metadata.summary) || text(metadata.excerpt),
    imageAssetId: leadMediaAssetIds(lead)[0] ?? "",
    alt: image ? image.alt : lead && lead.kind !== "image" ? leadMediaTitle(lead) : "",
    ...(image?.altDecorative === true ? { altDecorative: true } : {}),
    href: `/posts/${metadata.slug}/`,
  };
}

export function ContentShelfPicker({ onAdd, onAddPost, onPin, disabled, additionalPages = [], purpose = "shelf" }: {
  purpose?: "shelf" | "banner" | "hero-pin";
  additionalPages?: readonly { id: string; title: string; path: string }[];
  onAdd: (card: Record<string, unknown>) => void;
  onAddPost?: (card: Record<string, unknown>, postId: string) => void;
  onPin?: (pin: HomeHeroPin, title: string) => void;
  disabled: boolean;
}) {
  const sources = useContext(ContentShelfSources);
  const latest = useRef({ onAdd, onAddPost, onPin, disabled });
  latest.current = { onAdd, onAddPost, onPin, disabled };
  const id = useId();
  const [kind, setKind] = useState("page");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  const [loadedPages, setLoadedPages] = useState<{
    source: typeof sources.loadPages;
    entries: PageDirectoryEntry[];
  } | null>(null);
  const pageEntries = loadedPages?.source === sources.loadPages ? loadedPages?.entries ?? null : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const pageRequest = useRef(0);
  const addRequest = useRef(0);
  useEffect(() => () => {
    request.current++;
    pageRequest.current++;
    addRequest.current++;
  }, []);
  const canLoadPosts = Boolean(sources.loadLibrarySelection && sources.loadRecord);
  const pagesById = new Map<string, { id: string; title: string; href: string }>();
  for (const page of purpose === "hero-pin" ? [] : PUBLIC_PAGES) {
    pagesById.set(page.id, { id: page.id, title: page.title, href: page.path });
  }
  for (const page of purpose === "hero-pin" ? [] : additionalPages) {
    pagesById.set(page.id, { id: page.id, title: page.title, href: page.path });
  }
  for (const page of pageEntries ?? []) {
    if (page.published === true && page.livePath && (purpose !== "hero-pin" || (page.id !== "home" && !page.publicUpdatePending && (page.liveSourceVersion ?? 0) > 0))) {
      pagesById.set(page.id, { id: page.id, title: page.liveTitle ?? (purpose === "hero-pin" ? "Published Page" : page.title), href: page.livePath });
    }
  }
  const pages = [...pagesById.values()].filter(page =>
    page.title.toLowerCase().includes(query.toLowerCase()));

  async function loadPages() {
    if (!sources.loadPages || pageEntries !== null) return;
    const current = ++pageRequest.current;
    setBusy(true); setError("");
    try {
      const result = await sources.loadPages();
      if (current === pageRequest.current) setLoadedPages({ source: sources.loadPages, entries: result });
    } catch {
      if (current === pageRequest.current) setError("Pages could not be loaded. Try opening the picker again.");
    } finally {
      if (current === pageRequest.current) setBusy(false);
    }
  }

  async function search(page = 1) {
    if (!sources.loadLibrarySelection) return;
    const current = ++request.current;
    setBusy(true); setError(""); setSelection(null);
    try {
      const result = await sources.loadLibrarySelection({ ...DEFAULT_CONTENT_QUERY,
        types: ["post"], statuses: [], q: query.trim(), page });
      if (current === request.current) setSelection({ ...result, records: result.records.filter(record =>
        Number.isSafeInteger(record.liveSourceVersion) && (record.liveSourceVersion ?? 0) > 0 && !record.publicUpdatePending) });
    } catch { if (current === request.current) setError("Posts could not be loaded. Try the search again."); }
    finally { if (current === request.current) setBusy(false); }
  }

  function add(card: Record<string, unknown>) {
    if (latest.current.disabled) return;
    latest.current.onAdd(card);
    // The banner group announces whether a URL was accepted or already selected.
    if (purpose !== "banner") setNotice(`Added ${text(card.title)}. Complete or change its card fields below.`);
  }

  async function addPost(id: string) {
    if (!sources.loadRecord) return;
    const current = ++addRequest.current;
    setBusy(true); setError("");
    try {
      const result = await sources.loadRecord("post", id);
      if (current !== addRequest.current) return;
      if (result.status !== "ready" || result.record.deleted === true) {
        throw new Error("This post is no longer available. Search again.");
      }
      const card = postShelfCard(result.record);
      if (!latest.current.disabled && latest.current.onPin) {
        latest.current.onPin({ source: "cms_posts", sourceId: id }, text(card.title));
      } else if (!latest.current.disabled && latest.current.onAddPost) {
        latest.current.onAddPost(card, id);
        setNotice(`Added ${text(card.title)}. Blank hero fields follow its published story.`);
      } else add(card);
      const lead = readPostLeadMedia(object(object(result.record.published).metadata), true);
      if (!latest.current.disabled && !latest.current.onPin && !latest.current.onAddPost && purpose !== "banner" && lead?.kind === "library-video" && !lead.posterAssetId) {
        setNotice(`Added ${text(card.title)}. This shelf card needs an image before publication. Choose one for this card, or remove this card, add a poster to the Post, publish it and add it again. Generated video posters are not copied.`);
      }
    } catch (cause) { if (current === addRequest.current) setError(cause instanceof Error ? cause.message : "The post could not be added."); }
    finally { if (current === addRequest.current) setBusy(false); }
  }

  async function pinPage(id: string) {
    if (!sources.loadPages) { setError("Published Page choices are unavailable in this workspace."); return; }
    const current = ++addRequest.current;
    setBusy(true); setError("");
    try {
      const entries = await sources.loadPages();
      if (current !== addRequest.current) return;
      setLoadedPages({ source: sources.loadPages, entries });
      const page = entries.find(page => page.id === id);
      if (!page || page.published !== true || !page.livePath || page.publicUpdatePending || (page.liveSourceVersion ?? 0) < 1) {
        throw new Error("This Page has no settled public snapshot. Refresh the choices and try again.");
      }
      if (!latest.current.disabled) latest.current.onPin?.({ source: "cms_pages", sourceId: id }, page.liveTitle ?? "Published Page");
    } catch (cause) { if (current === addRequest.current) setError(cause instanceof Error ? cause.message : "The Page could not be pinned."); }
    finally { if (current === addRequest.current) setBusy(false); }
  }

  return <details className="inline-shelf-picker" onToggle={event => {
    if (event.currentTarget.open) void loadPages();
  }}>
    <summary>{purpose === "hero-pin" ? "Pin published content" : purpose === "banner" ? "Choose pages" : "Add existing content"}</summary>
    <p>{purpose === "hero-pin" ? "Choose a published Post or Page. Pins follow its published title, summary, image and destination."
      : purpose === "banner" ? "Choose a published Page or Post, or a fixed site destination."
      : onAddPost ? "Choose a page or published post. Blank fields follow a selected Post; Home overrides stay editable." : "Choose a page or published post. Its card stays editable in this shelf."}</p>
    <label htmlFor={`${id}-kind`}>Content type</label>
    <Select id={`${id}-kind`} value={kind} disabled={busy} onChange={event => {
      request.current++; setKind(event.target.value); setSelection(null); setError(""); setQuery("");
    }}>
      <option value="page">Pages</option>
      {canLoadPosts ? <option value="post">Published posts</option> : null}
    </Select>
    <label htmlFor={`${id}-query`}>Find content</label>
    <TextInput id={`${id}-query`} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
    {kind === "post" ? <Button disabled={busy} onClick={() => void search()}>Search posts</Button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {busy ? <LoadingIndicator label="Loading content" stages={["Asking the CMS for matching content"]} /> : <p role="status">{notice}</p>}
    <ul>
      {kind === "page" ? pages.map(page => <li key={page.id}>
        <Button disabled={disabled || busy} onClick={() => purpose === "hero-pin" ? void pinPage(page.id) : add({ itemId: mintCollectionItemId(),
          title: page.title, href: page.href, summary: "", imageAssetId: "", alt: "" })}>{purpose === "hero-pin" ? "Pin" : "Add"} {page.title}</Button>
      </li>) : selection?.records.map(record => <li key={record.id}>
        <Button disabled={disabled || busy} onClick={() => void addPost(record.id)}>{purpose === "hero-pin" ? "Pin" : "Add"} {record.title}</Button>
      </li>)}
    </ul>
    {kind === "page" && pages.length === 0 ? <p>No pages match.</p> : null}
    {kind === "post" && selection ? <>
      <p>{selection.records.length === 0 ? "No live posts on this results page." : `Page ${selection.page} of ${selection.pageCount}`}</p>
      <Button disabled={busy || selection.page <= 1} onClick={() => void search(selection.page - 1)}>Previous posts</Button>
      <Button disabled={busy || selection.page >= selection.pageCount} onClick={() => void search(selection.page + 1)}>Next posts</Button>
    </> : null}
  </details>;
}
