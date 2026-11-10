import { createRoot } from "react-dom/client";
import "../styles.css";
import { BlockEditor } from "../components/BlockEditor";
import { HomePreviewFrame } from "../components/HomePreviewFrame";
import { ComponentPhoneFrame } from "../components/ComponentPhonePreview";
import { HomeShelfLayoutPreview } from "../components/HomeShelfLayoutPreview";
import { shelfLayoutFixture } from "../../../packages/content-core/fixtures/home-shelf-layouts";
import { adaptHomeSpotlight } from "../../../packages/content-core/src/home-spotlight-source";
import { renderHomeCuratedShelf } from "../../../packages/content-core/src/home-curated-render";
import { renderHomeEditorialHero } from "../../../packages/content-core/src/home-editorial-render";
import { spotlightStoryImage } from "../../../packages/content-core/src/spotlight-image.mjs";
import { readHomeEditorialSourceReceipt } from "../../../packages/content-core/src/home-source-catalog";
import copiedFeed from "../../tests/fixtures/spotlight-copied.json";
import beforeFeed from "../../tests/fixtures/spotlight-before.json";
import type { AdminBlock } from "../lib/block-factory";

// Local saved snapshot and real renderer owners; no auth, server save or publication.
const fixture = shelfLayoutFixture("two_features", "filled");
const feed = new URLSearchParams(location.search).get("phase") === "before" ? beforeFeed : copiedFeed;
const cutoffAt = feed.checkedAt;
const source = adaptHomeSpotlight({ ...feed, status: "ready" }, { cutoffAt });
fixture.sources.editorial!.catalog.cutoffAt = cutoffAt;
fixture.sources.editorial!.catalog.sources["home-spotlight"] = { status: "ready", checkedAt: cutoffAt, cards: source.cards };
fixture.sources.editorial = readHomeEditorialSourceReceipt(JSON.parse(JSON.stringify(fixture.sources.editorial)));
Object.assign(fixture.block.data, { presentation: "grid", columns: 2, title: "NJ Spotlight News", itemLimit: 4, selectedIds: source.cards.slice(0, 4).map(card => card.id) });
const loadSources = async () => fixture.sources;
const surface = new URLSearchParams(location.search).get("surface");
const html = renderHomeCuratedShelf(fixture.block, fixture.sources.editorial!.catalog);
const heroHtml = renderHomeEditorialHero(feed.cards.slice(0, 4).map(card => ({
  id: card.href, href: card.href, title: card.title, summary: "",
  image: spotlightStoryImage(card),
})), { supportingCount: 3 });
createRoot(document.getElementById("spotimg-root")!).render(surface === "editor"
  ? <BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={fixture.home.blocks as AdminBlock[]} commandsInline onSave={async () => { throw new Error("Evidence never saves"); }} allowConflictOverwrite={false} loadHomeSources={loadSources} />
  : surface === "hero-preview"
  ? <HomePreviewFrame html={heroHtml} title="Saved Spotlight hero snapshot" />
  : surface === "phone"
  ? <HomeShelfLayoutPreview block={fixture.block as unknown as AdminBlock} homeV2 loadSources={loadSources} render={markup => <ComponentPhoneFrame html={markup} title="NJ Spotlight News" styles="" />} />
  : <HomePreviewFrame html={html} title="Saved Home v2 Spotlight snapshot" />);
