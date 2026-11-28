import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { canUseAudioLibrary, canUseMediaLibrary } from "../../lib/access";
import { cmsListMedia, HttpError, type MediaAssetKind, type MediaAssetSummary } from "../../lib/functions";
import { DEFAULT_MEDIA_QUERY } from "../../lib/media-query";
import { mediaImagesPath, mediaVideosPath, mediaVoiceoversPath } from "../../lib/routes";
import { searchMedia } from "../../lib/source-media";
import { Icon, type IconName } from "../ui/Icon";
import { SegmentedControl } from "../ui/SegmentedControl";
import "./MediaSearchAll.css";

/** The most hits each kind shows. The tab itself lists the rest. */
export const MEDIA_SEARCH_ALL_HITS = 5;
const VIDEO_QUERY_LIMIT = 160;
const PRIMARY_VIDEO_SOURCE = "video-library";

export type MediaSearchAllKind = "images" | "videos" | "audio";
type KindFilter = "all" | MediaSearchAllKind;

interface Hit {
  id: string;
  name: string;
  kindLabel: string;
  icon: IconName;
  thumbnail: string | null;
  to: string;
}

type KindState =
  | { status: "loading" }
  | { status: "ready"; hits: Hit[] }
  | { status: "error" }
  | { status: "hidden" };

const KIND_LABELS: Record<MediaSearchAllKind, string> = { images: "Images", videos: "Videos", audio: "Audio" };
const KIND_ORDER: readonly MediaSearchAllKind[] = ["images", "videos", "audio"];
const EMPTY_MESSAGES: Record<MediaSearchAllKind, string> = {
  images: "No images or documents match.",
  videos: "No videos match.",
  audio: "No audio matches.",
};
const ERROR_MESSAGES: Record<MediaSearchAllKind, string> = {
  images: "Images could not be searched. Try again later.",
  videos: "Videos could not be searched. Try again later.",
  audio: "Audio could not be searched. Try again later.",
};

export interface MediaSearchAllProps {
  /** The applied search from the URL. It already waits for the search field's typing pause. */
  query: string;
  principal: Parameters<typeof canUseMediaLibrary>[0] | null;
  getIdToken: () => Promise<string>;
}

function withQuery(path: string, q: string, key: "selected" | "asset", id: string): string {
  return `${path}?${new URLSearchParams({ q, [key]: id })}`;
}

function libraryHit(asset: MediaAssetSummary, q: string): Hit {
  const audio = asset.kind === "audio";
  const image = asset.kind === "image";
  return {
    id: asset.id,
    name: asset.name,
    kindLabel: audio ? "Audio" : image ? "Image" : "Document",
    icon: audio ? "microphone" : image ? "image" : "file",
    thumbnail: image ? asset.thumbnails?.[0]?.url ?? asset.url : null,
    to: withQuery(audio ? mediaVoiceoversPath() : mediaImagesPath(), q, "selected", asset.id),
  };
}

async function loadLibrary(getIdToken: () => Promise<string>, q: string, kinds: MediaAssetKind[], signal: AbortSignal) {
  const result = await cmsListMedia(await getIdToken(), {
    ...DEFAULT_MEDIA_QUERY, q, kinds, pageSize: MEDIA_SEARCH_ALL_HITS,
  }, signal);
  return result.records.slice(0, MEDIA_SEARCH_ALL_HITS).map((asset) => libraryHit(asset, q));
}

async function loadVideos(getIdToken: () => Promise<string>, q: string, signal: AbortSignal) {
  const page = await searchMedia(await getIdToken(), { q: q.slice(0, VIDEO_QUERY_LIMIT), limit: MEDIA_SEARCH_ALL_HITS }, signal);
  return page.records.slice(0, MEDIA_SEARCH_ALL_HITS).map((record): Hit => ({
    id: record.id,
    name: record.name,
    kindLabel: "Video",
    icon: "video",
    thumbnail: null,
    to: withQuery(record.sourceId === PRIMARY_VIDEO_SOURCE ? mediaVideosPath() : mediaVideosPath(record.sourceId),
      q, "asset", record.id),
  }));
}

// The "All media" results under a media tab's search box. One query finds images,
// documents, videos and audio. Each kind loads and fails on its own, and each hit opens
// the item on its own tab with the same search.
export function MediaSearchAll({ getIdToken, principal, query }: MediaSearchAllProps) {
  const headingId = useId();
  const q = query.trim();
  const mayUseImages = Boolean(principal && canUseMediaLibrary(principal));
  const mayUseAudio = Boolean(principal && canUseAudioLibrary(principal));
  // A new token callback on each parent render must not restart the search.
  const tokenRef = useRef(getIdToken);
  tokenRef.current = getIdToken;
  const [filter, setFilter] = useState<KindFilter>("all");
  const [results, setResults] = useState<Record<MediaSearchAllKind, KindState>>(() => ({
    images: { status: "loading" }, videos: { status: "loading" }, audio: { status: "loading" },
  }));

  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const token = () => tokenRef.current();
    const settle = (kind: MediaSearchAllKind, load: () => Promise<Hit[]>, hideOnForbidden = false) => {
      setResults((current) => ({ ...current, [kind]: { status: "loading" } }));
      load().then(
        (hits) => {
          if (!controller.signal.aborted) setResults((current) => ({ ...current, [kind]: { status: "ready", hits } }));
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          // cmsSearchMedia answers 403 when the person can see no video source.
          const hidden = hideOnForbidden && error instanceof HttpError && error.status === 403;
          setResults((current) => ({ ...current, [kind]: { status: hidden ? "hidden" : "error" } }));
        },
      );
    };
    setResults((current) => ({
      ...current,
      ...(mayUseImages ? {} : { images: { status: "hidden" } }),
      ...(mayUseAudio ? {} : { audio: { status: "hidden" } }),
    }));
    if (mayUseImages) settle("images", () => loadLibrary(token, q, ["image", "document"], controller.signal));
    settle("videos", () => loadVideos(token, q, controller.signal), true);
    if (mayUseAudio) settle("audio", () => loadLibrary(token, q, ["audio"], controller.signal));
    return () => controller.abort();
  }, [mayUseAudio, mayUseImages, q]);

  if (!q) return null;
  const available = KIND_ORDER.filter((kind) => results[kind].status !== "hidden");
  if (available.length === 0) return null;
  const shownFilter = filter !== "all" && available.includes(filter) ? filter : "all";
  const shown = shownFilter === "all" ? available : [shownFilter];

  return (
    <section aria-labelledby={headingId} className="media-search-all">
      <div className="media-search-all-header">
        <h3 className="media-search-all-title" id={headingId}>All media</h3>
        {available.length > 1 ? (
          <SegmentedControl
            label="Show kind"
            onChange={setFilter}
            options={[{ value: "all" as const, label: "All" },
              ...available.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))]}
            value={shownFilter}
          />
        ) : null}
      </div>
      <div className="media-search-all-groups">
        {shown.map((kind) => {
          const state = results[kind];
          const groupId = `${headingId}-${kind}`;
          return (
            <div aria-labelledby={groupId} className="media-search-all-group" key={kind} role="group">
              <h4 className="media-search-all-group-title" id={groupId}>{KIND_LABELS[kind]}</h4>
              {state.status === "loading" ? <p className="media-search-all-note" role="status">Searching {KIND_LABELS[kind].toLowerCase()}.</p>
                : state.status === "error" ? <p className="media-search-all-note" role="alert">{ERROR_MESSAGES[kind]}</p>
                : state.status === "ready" && state.hits.length === 0
                  ? <p className="media-search-all-note">{EMPTY_MESSAGES[kind]}</p>
                  : state.status === "ready" ? (
                    <ul className="media-search-all-list">
                      {state.hits.map((hit) => (
                        <li key={hit.id}>
                          <Link className="media-search-all-hit" to={hit.to}>
                            <span aria-hidden="true" className="media-search-all-thumb">
                              {hit.thumbnail ? <img alt="" decoding="async" loading="lazy" src={hit.thumbnail} />
                                : <Icon name={hit.icon} />}
                            </span>
                            <span className="media-search-all-name">{hit.name}</span>
                            <span className="media-search-all-kind">{hit.kindLabel}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
