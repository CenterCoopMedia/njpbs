import { useCallback, useEffect, useId, useRef, useState } from "react";
import coverFont from "../../../site/src/assets/pdf-fonts/PublicSans-Regular.ttf?url&inline";
import coverBoldFont from "../../../site/src/assets/pdf-fonts/PublicSans-Bold.ttf?url&inline";
import type { RichTextDoc } from "../../../packages/content-core/src/content-model";
import { BlockEditor, type BlockEditorHandle } from "../components/BlockEditor";
import { Button } from "../components/ui/Primitives";
import { createBlock, type AdminBlock } from "../lib/block-factory";
import { readOnlyNotice } from "../lib/editor-save-decisions";
import type {
  ListMediaResponse,
  MediaAssetSummary,
  MediaListQuery,
} from "../lib/functions";

type DocumentKind = "post" | "page";
type SpecimenState = "ready" | "validation" | "readonly";

interface EditorStructureSpecimenProps {
  kind?: DocumentKind;
  state?: SpecimenState;
}

// These are synthetic covers, not photographs or published reporting. Keeping them in
// data URLs makes canvas, picker and phone-preview checks independent of a media server.
// Embed open fonts: SVG images cannot inherit the page font.
function coverImage(title: string, subtitle: string, alternate = false): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
    <style>
      @font-face { font-family: "Cover fixture"; src: url("${coverFont}") format("truetype"); }
      @font-face { font-family: "Cover fixture"; src: url("${coverBoldFont}") format("truetype"); font-weight: 700; }
    </style>
    <rect width="960" height="540" fill="#0A145A"/>
    <path d="M0 300L180 210L320 285L520 170L710 260L960 145V540H0Z" fill="${alternate ? "#4D5EE8" : "#2638C4"}"/>
    <path d="M0 410L220 330L430 420L660 300L960 395V540H0Z" fill="${alternate ? "#2638C4" : "#4D5EE8"}"/>
    <text x="56" y="94" fill="#FFFFFF" font-family="Cover fixture" font-size="27">${subtitle}</text>
    <text x="52" y="162" fill="#FFFFFF" font-family="Cover fixture" font-size="52" font-weight="700">${title}</text>
  </svg>`)}`;
}

function mediaAsset(id: string, name: string, alternate = false): MediaAssetSummary {
  return {
    id,
    name,
    originalName: `${id}.svg`,
    category: "news",
    categories: ["news"],
    tags: ["layout specimen"],
    description: "Synthetic cover for local editor review.",
    altText: "Layered blue landscape illustration",
    license: "Local design specimen",
    credit: "NJ PBS design gallery",
    mimeType: "image/svg+xml",
    kind: "image",
    sizeBytes: 1024,
    width: 960,
    height: 540,
    url: coverImage(name, "Stories across New Jersey", alternate),
    lifecycle: "active",
    version: 1,
    etag: `"media.${id}.1"`,
    createdAt: "2026-10-08T12:00:00.000Z",
    createdBy: "gallery-editor",
    updatedAt: "2026-10-08T12:00:00.000Z",
    updatedBy: "gallery-editor",
  };
}

const MEDIA = [
  mediaAsset("structure-community", "Community in focus"),
  mediaAsset("structure-places", "People and places", true),
];

const loadMedia = async (query: MediaListQuery): Promise<ListMediaResponse> => {
  const search = query.q.toLocaleLowerCase("en-US");
  const records = MEDIA.filter(asset =>
    (!query.assetIds || query.assetIds.includes(asset.id)) &&
    (!query.kinds.length || query.kinds.includes("image")) &&
    (!query.categories.length || query.categories.includes(asset.category)) &&
    (!search || `${asset.name} ${asset.id}`.toLocaleLowerCase("en-US").includes(search)),
  );
  return {
    success: true,
    records,
    total: records.length,
    allCount: MEDIA.length,
    page: 1,
    pageCount: 1,
    categoryCounts: { news: MEDIA.length },
    kindCounts: { image: MEDIA.length, document: 0 },
  };
};

function paragraphs(...text: string[]): RichTextDoc {
  return {
    type: "doc",
    content: text.map(value => ({
      type: "paragraph",
      content: [{ type: "text", text: value }],
    })),
  };
}

function plank(
  type: AdminBlock["type"],
  id: string,
  data: Record<string, unknown>,
  layout?: AdminBlock["layout"],
  visible = true,
): AdminBlock {
  const block = createBlock(type, id);
  return { ...block, data: { ...block.data, ...data }, ...(layout ? { layout } : {}), visible };
}

/** Real saved-document shapes. State changes are exercised through BlockEditor's API. */
export function editorStructureBlocks(kind: DocumentKind, state: SpecimenState = "ready"): AdminBlock[] {
  const prefix = `editor-structure-${kind}`;
  const at = (row: string, column: number) => ({ rowId: `${prefix}-${row}`, column });
  const image = {
    assetId: MEDIA[0].id,
    alt: "Layered blue landscape with the words Community in focus",
    caption: "Stories from across the Garden State.",
  };
  const copy = {
    content: state === "validation"
      ? { type: "doc", content: [{ type: "paragraph" }] }
      : paragraphs(
          "New Jersey stories begin with the people who live them. Follow the conversations, places and everyday decisions that shape our communities.",
          "Our coverage brings local voices together and makes room for the context behind the headlines.",
          "Explore related reporting and find more to watch from NJ PBS below.",
        ),
  };
  const blocks = kind === "post" ? [
    plank("row", `${prefix}-lead`, { columns: [8, 4] }),
    plank("image", `${prefix}-image`, image, at("lead", 0)),
    plank("prose", `${prefix}-copy`, copy, at("lead", 1)),
    plank("link_card", `${prefix}-related`, {
      title: "More reporting from New Jersey",
      url: "https://www.njspotlightnews.org/",
      source: "NJ Spotlight News",
      summary: "Context and continuing coverage from across the state.",
    }, at("lead", 1), false),
    plank("image_gallery", `${prefix}-gallery`, {
      presentation: "grid",
      images: MEDIA.map((asset, index) => ({
        itemId: `${prefix}-gallery-${index + 1}`,
        assetId: asset.id,
        alt: asset.altText,
        caption: asset.name,
      })),
    }),
    plank("cta_row", `${prefix}-buttons`, {
      ctas: [
        { itemId: `${prefix}-watch`, label: "Watch NJ PBS", href: "https://watch.njpbs.org/" },
        { itemId: `${prefix}-live`, label: "Watch live", href: "/live/" },
      ],
    }),
  ] : [
    plank("headline", `${prefix}-heading`, { text: "Explore New Jersey with us", level: 2 }),
    plank("row", `${prefix}-lead`, { columns: [8, 4] }),
    plank("prose", `${prefix}-copy`, copy, at("lead", 0)),
    plank("image", `${prefix}-image`, image, at("lead", 1)),
    plank("row", `${prefix}-details`, { columns: [4, 8] }),
    plank("faq_item", `${prefix}-question`, {
      question: "Where can I find more to watch?",
      answer: paragraphs("Explore NJ PBS programs and on-demand episodes in the Watch destination."),
    }, at("details", 0)),
    plank("data_table", `${prefix}-table`, {
      title: "Stories taking shape",
      csv: "Topic,Format,Stage\nCommunity,Interview,Planning\nEnvironment,Field report,Editing\nLocal history,Explainer,Draft",
      source: "Illustrative editorial planning data",
      sourceHref: "",
    }, at("details", 1)),
    plank("cta_row", `${prefix}-buttons`, {
      ctas: [{ itemId: `${prefix}-watch`, label: "Explore NJ PBS programs", href: "https://watch.njpbs.org/" }],
    }, at("details", 1)),
    plank("row", `${prefix}-resources`, { columns: [4, 4, 4] }),
    plank("link_card", `${prefix}-resource`, {
      title: "Watch NJ PBS",
      url: "https://watch.njpbs.org/",
      summary: "Find programs and on-demand episodes.",
    }, at("resources", 0)),
    plank("link_card", `${prefix}-related`, {
      title: "More reporting from New Jersey",
      url: "https://www.njspotlightnews.org/",
      source: "NJ Spotlight News",
    }, at("resources", 1), false),
    // The last column intentionally stays empty to exercise its insertion target.
  ];
  return blocks.map((block, order) => ({ ...block, order }));
}

function StructureDocument({ kind, state }: Required<EditorStructureSpecimenProps>) {
  const [seed] = useState(() => editorStructureBlocks(kind, state));
  const saved = useRef(seed);
  const [opened, setOpened] = useState(seed);
  const [revision, setRevision] = useState(0);
  const editor = useRef<BlockEditorHandle>(null);
  const surface = useRef<HTMLElement>(null);
  const nextId = useRef(0);
  const headingId = useId();
  const frozen = state === "readonly";
  const title = kind === "post" ? "Community in focus: stories across New Jersey" : "Explore New Jersey with us";
  const newId = useCallback(() => `editor-structure-${kind}-added-${++nextId.current}`, [kind]);
  const save = useCallback((blocks: AdminBlock[]) => { saved.current = structuredClone(blocks); }, []);

  useEffect(() => {
    if (state === "validation") {
      // Use the same refusal path as the real editor, including its focus, field messages
      // and dialog. No validation appearance or error state is manufactured in this fixture.
      editor.current?.validateForPublication();
    } else if (!frozen) {
      surface.current?.querySelector<HTMLElement>(`[id="block-card-editor-structure-${kind}-copy"]`)
        ?.focus({ preventScroll: true });
    }
  }, [frozen, kind, revision, state]);

  return <section className="record-form" ref={surface} aria-labelledby={headingId}>
    <div className="post-editor-writing-boundary">
      <div className="post-body-heading">
        <h2 id={headingId}>{title}</h2>
        <p>{kind === "post" ? "Post body" : "Page content"} · Local design specimen</p>
      </div>
      <BlockEditor
        key={revision}
        ref={editor}
        section={kind === "post" ? "post" : "genericPage"}
        emptyDocumentKind={kind}
        pageTitle={title}
        initialBlocks={opened}
        newId={newId}
        commandsInline
        onSave={save}
        loadMedia={loadMedia}
        readOnly={frozen}
        canSave={!frozen}
        readOnlyNotice={frozen ? readOnlyNotice({
          status: "in_review", restoring: false, changingLifecycle: false, noun: kind,
        }) : null}
      />
    </div>
    <div className="button-row">
      <Button onClick={() => { setOpened(structuredClone(saved.current)); setRevision(value => value + 1); }}>
        Reopen saved {kind}
      </Button>
      <Button onClick={() => {
        saved.current = structuredClone(seed);
        setOpened(structuredClone(seed));
        setRevision(value => value + 1);
      }}>Reset specimen</Button>
    </div>
  </section>;
}

// Gallery entries are document-isolated so focus, dialogs and the responsive canvas use
// the same DOM and viewport boundaries as the shipped editor. The caller supplies the
// control-presentation provider; this fixture must not pin one of its two modes.
export function EditorStructureSpecimen({ kind = "post", state = "ready" }: EditorStructureSpecimenProps) {
  return <StructureDocument key={`${kind}-${state}`} kind={kind} state={state} />;
}
