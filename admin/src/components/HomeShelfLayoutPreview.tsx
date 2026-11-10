import { useCoverageLabels } from "../context/CoverageLabelsContext";
import { CoverageLabelPreviewStatus } from "./CoverageLabelPreviewStatus";
import { useEffect, useState, type ReactNode } from "react";
import { parseBlocks, type ContentShelfBlock } from "../../../packages/content-core/src/content-model";
import { renderHomeNewsRail, renderHomeProgramRail, type HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { AdminBlock } from "../lib/block-factory";
import { loadHomeSourceSnapshot } from "../lib/home-source-snapshot";
import { Button } from "./ui/Primitives";
import { renderHomeCuratedShelf } from "../../../packages/content-core/src/home-curated-render";
import { resolveHomeShelf } from "../../../packages/content-core/src/home-source-catalog";

type SourceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; source: string; value: HomeSourceSnapshot };

/** Mounted only while the existing component phone panel is open and expanded. */
export function HomeShelfLayoutPreview({ block, loadSources = loadHomeSourceSnapshot, render, homeV2 = false }: {
  block: AdminBlock;
  loadSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  render: (html: string) => ReactNode;
  homeV2?: boolean;
}) {
  const parsed = parseBlocks([{ ...block, order: 0, layout: undefined }]);
  const shelf = parsed.ok && parsed.blocks[0]?.type === "content_shelf"
    ? parsed.blocks[0] as ContentShelfBlock : undefined;
  const source = shelf?.data.source;
  const coverage = useCoverageLabels(source === "station_posts");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SourceState>({ status: "loading" });

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    let current = true;
    setState({ status: "loading" });
    const timer = window.setTimeout(() => {
      controller.abort();
      if (current) setState({ status: "error", message: "The published cards took too long to load. Your draft is still available." });
    }, 10_000);
    void loadSources(controller.signal).then(value => {
      if (!value.publication) throw new Error("The source cards have no matching publication receipt. Try loading them again.");
      if (current && !controller.signal.aborted) setState({ status: "ready", source, value });
    }).catch(error => {
      if (current) setState({ status: "error", message: controller.signal.aborted
        ? "The published cards took too long to load. Your draft is still available."
        : error instanceof Error ? error.message : "The published cards could not be loaded." });
    }).finally(() => window.clearTimeout(timer));
    return () => {
      current = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  // Headings, counts and layout changes reuse this panel's captured source.
  }, [source, loadSources, attempt]);

  if (!shelf) return <p role="status">Complete this shelf's fields to see its preview.</p>;
  if (state.status === "error") return <div role="alert">
    <p>{state.message}</p>
    <p>You can keep editing this shelf's settings.</p>
    <Button onClick={() => setAttempt(value => value + 1)}>Retry loading published cards</Button>
  </div>;
  if (state.status !== "ready" || state.source !== source) return <p role="status">Loading published cards…</p>;
  const { value } = state;
  if (homeV2 || shelf.data.selectedIds !== undefined || shelf.section === "home-posts") {
    if (!value.editorial) return <p role="alert">The current published source catalog is unavailable. Your selections are unchanged.</p>;
    const resolved = resolveHomeShelf(shelf, value.editorial.catalog);
    return <><p>Published cards from generation {value.publication!.generation}.</p>
      {source === "station_posts" && resolved.cards.some(card => card.coverageLabelId) ? <CoverageLabelPreviewStatus /> : null}
      {resolved.missingIds.length ? <p role="alert">{resolved.missingIds.length} selected cards are withdrawn or unavailable and do not appear on Home.</p> : null}
      {resolved.cards.length === 0 ? <p role="alert">{shelf.data.title} is omitted from Home: {resolved.emptyReason === "source_error" ? "the published source is unavailable" : "no selected or eligible published cards remain"}.</p> : null}
      {render(renderHomeCuratedShelf(shelf, value.editorial.catalog, coverage.registry))}</>;
  }
  const sourceLabel = shelf.data.source === "spotlight_news"
    ? "NJ Spotlight News source: RSS"
    : `PBS source: ${value.pbs.source === "manual" ? "manually selected programs" : "Media Manager"}`;
  const checkedAt = shelf.data.source === "spotlight_news" ? value.spotlight.checkedAt : value.pbs.checkedAt;
  let html: string;
  let count: number;
  if (shelf.data.source === "spotlight_news") {
    const cards = value.spotlight.cards.slice(0, shelf.data.itemLimit);
    count = cards.length;
    html = renderHomeNewsRail(cards, shelf.data);
  } else {
    const kind = shelf.data.source === "pbs_featured" ? "featured" : "more";
    const cards = value.pbs[kind].slice(0, shelf.data.itemLimit).map((card, index) => ({ ...card, index, external: true }));
    count = cards.length;
    html = renderHomeProgramRail(kind, cards, shelf.data.moreHref, true, shelf.data);
  }
  return <>
    <p className="muted">Published cards from generation {value.publication!.generation}. The heading and layout reflect your draft.</p>
    <p className="muted">{sourceLabel}. {checkedAt
      ? <>Source checked <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time>. Source check time is not the publication time.</>
      : "No source check time recorded."}</p>
    {count === 0 ? <p role="status">This published source has no cards. The section's heading and more link remain visible.</p> : null}
    {render(html)}
  </>;
}
