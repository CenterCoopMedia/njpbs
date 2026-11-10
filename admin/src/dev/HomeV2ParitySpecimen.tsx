import { useCallback, useEffect, useState } from "react";
import type { MediaAssetSummary } from "../lib/functions";
import type { MediaPickerLoader } from "../components/MediaPickerDialog";
import { BlockEditor } from "../components/BlockEditor";
import type { AdminBlock } from "../lib/block-factory";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";

/** The parity probe supplies a saved snapshot and captured public dependencies.
 * This dev-only fixture never reads or writes a CMS database.
 */
export function HomeV2ParitySpecimen() {
  const [input, setInput] = useState<{ home: { blocks: AdminBlock[] }; sources: HomeSourceSnapshot; mediaAssets?: MediaAssetSummary[] }>();
  const [reopen, setReopen] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/_home-parity-input.json", { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Unavailable parity input"); return response.json(); })
      .then(setInput).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  const loadMedia = useCallback<MediaPickerLoader>(async query => {
    const records = (input?.mediaAssets ?? []).filter(asset => !query.assetIds?.length || query.assetIds.includes(asset.id));
    return { success: true, records, page: 1, total: records.length, allCount: records.length, pageCount: 1, categoryCounts: {}, kindCounts: { image: records.length } };
  }, [input?.mediaAssets]);
  if (error) return <p role="alert">Run the local Home parity probe to supply its saved snapshot.</p>;
  if (!input) return <p role="status">Loading saved parity snapshot</p>;
  return <>
    <button onClick={() => setReopen(value => value + 1)}>Reopen saved Home</button>
    <BlockEditor key={reopen} section="home" pageId="home" homeCompositionVersion={2}
      initialBlocks={input.home.blocks} loadMedia={loadMedia} loadHomeSources={async () => input.sources}
      commandsInline onSave={async blocks => setInput({ ...input, home: { ...input.home, blocks } })} />
    <output hidden data-home-parity-saved={JSON.stringify(input.home.blocks)} />
  </>;
}
