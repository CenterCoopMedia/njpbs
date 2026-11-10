import { useState } from "react";
import { BlockEditor } from "../components/BlockEditor";
import { HomeHeroEditor } from "../components/HomeHeroEditor";
import { HomeHeroModal } from "../components/HomeHeroModal";
import { HomeHeroLayoutPreview } from "../components/HomeHeroLayoutPreview";
import { Button } from "../components/ui/Primitives";
import type { AdminBlock } from "../lib/block-factory";
import { shelfLayoutFixture, heroActionFixture, type ShelfLayoutState } from "../../../packages/content-core/fixtures/home-shelf-layouts";

const query = new URLSearchParams(window.location.search);
const layout = query.get("layout") === "list" ? "list" : "two_features";
const state = (["filled", "one", "empty", "withdrawn", "many"].includes(query.get("state") ?? "") ? query.get("state") : "filled") as ShelfLayoutState;
const fixture = shelfLayoutFixture(layout, state);
const loadSources = async () => fixture.sources;
export function HomeShelfLayoutsGallery() {
  const [saved, setSaved] = useState(fixture.home.blocks as AdminBlock[]);
  const [reopen, setReopen] = useState(0);
  const [hero, setHero] = useState(heroActionFixture());
  if (query.get("surface") === "hero") return <div className="record-form">
    <HomeHeroModal value={hero} preview={<HomeHeroLayoutPreview value={hero} loadSources={loadSources} />}>
      <HomeHeroEditor value={hero} onChange={setHero} loadSources={loadSources} />
    </HomeHeroModal>
    <output hidden data-hero-fixture={JSON.stringify(hero)} />
  </div>;
  return <>
    <Button onClick={() => setReopen(value => value + 1)}>Reopen saved Home</Button>
    <BlockEditor key={reopen} section="home" pageId="home" homeCompositionVersion={2}
      initialBlocks={saved} commandsInline onSave={async blocks => setSaved(blocks)}
      allowConflictOverwrite={false} loadHomeSources={loadSources} />
    <output hidden data-home-shelf-saved={JSON.stringify(saved)} />
  </>;
}
