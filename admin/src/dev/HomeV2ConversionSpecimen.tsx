import { useCallback, useRef, useState } from "react";
import { EditorWorkspace, type PageContent } from "../components/EditorWorkspace";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { AdminBlock } from "../lib/block-factory";
import fixture from "../../../site/tests/fixtures/home-composition-v1.json";

// Local UI evidence only. The server conversion and detached public snapshot are
// proved independently through real Firestore transactions in home-v2.test.ts.
const preset = ["home-start", "home-start-action", "home-spotlight", "home-featured", "home-more", "home-newsletter", "home-passport-copy", "home-passport-action"];
const surface = { kind: "page", pageId: "home", section: "home" } as const;
const principal = { id: "fixture-editor", grants: [{ role: "editor", sections: ["station"] }] } as const;
export function HomeV2ConversionSpecimen({ loadHomeSources }: { loadHomeSources: () => Promise<HomeSourceSnapshot> }) {
  const saved = useRef<PageContent>({ blocks: fixture.blocks as AdminBlock[], version: 7, status: "published", homeCompositionVersion: 1,
    metadata: { title: "Home", homeHero: { mode: "manual", items: [] } }, publiclyVisible: true, publicSourceVersion: 5, publishedSourceVersion: 5 });
  const [converted, setConverted] = useState(false);
  const loadPage = useCallback(async () => structuredClone(saved.current), []);
  const convertHomeV2 = useCallback(async (baseVersion: number) => {
    if (baseVersion !== saved.current.version) throw new Error("Reload Home before changing its layout.");
    saved.current = { ...saved.current, status: "draft", version: baseVersion + 1, homeCompositionVersion: 2,
      metadata: { ...saved.current.metadata, homeHero: { mode: "manual", items: [], presentation: "editorial" } },
      blocks: preset.map(section => section === "home-newsletter"
        ? { id: "converted-newsletter", section, type: "newsletter_signup" as const, visible: true, data: { newsletterIds: [], actionLabel: "Sign up by email" } }
        : saved.current.blocks.find(block => block.section === section)!).map((block, order) => ({ ...block, order })) };
    setConverted(true);
    return structuredClone(saved.current);
  }, []);
  const props = { principal, surface, loadPage, convertHomeV2, loadHomeSources,
    savePage: async () => structuredClone(saved.current), savePageMetadata: async () => structuredClone(saved.current) };
  return <div data-home-conversion-state={converted ? "converted" : "original"}>
    <EditorWorkspace {...props} />
    <output hidden data-home-conversion-saved={JSON.stringify(saved.current)} />
  </div>;
}
