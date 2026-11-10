import { useState } from "react";
import energyImage from "../../../site/public/brand/spotlight/energy-environment.jpg";
import domeImage from "../../../site/public/brand/spotlight/under-the-dome.jpg";
import { ImageViewer } from "../components/media/ImageViewer";
import { Button, InlineMessage } from "../components/ui/Primitives";
import type {
  DeleteMediaResponse,
  MediaAssetSummary,
  MediaCategoryDefinition,
  UpdateMediaMetadata,
  UpdateMediaMetadataResponse,
} from "../lib/functions";

const CATEGORIES: readonly MediaCategoryDefinition[] = [
  ["news", "News", true],
  ["programs", "Programs", false],
].map(([id, label, primary], index) => ({
  id: String(id),
  label: String(label),
  description: `${label} media`,
  order: (index + 1) * 10,
  active: true,
  reserved: false,
  version: 1,
  etag: `"media-category.${id}.1"`,
  canUpload: Boolean(primary),
  canManage: true,
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
}));

function image(
  id: string,
  name: string,
  url: string,
  overrides: Partial<MediaAssetSummary> = {},
): MediaAssetSummary {
  return {
    id,
    name,
    originalName: `${id}.jpg`,
    category: "news",
    categories: ["news", "programs"],
    tags: ["statehouse", "trenton", "b-roll"],
    description: "Newsroom reference image from a local gallery fixture.",
    altText: "The New Jersey State House dome under a blue evening sky.",
    license: "NJ PBS owned",
    credit: "NJ PBS newsroom",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 2_202_009,
    width: 2_400,
    height: 1_600,
    url,
    thumbnails: [{ url, width: 960, height: 640 }],
    source: "upload",
    lifecycle: "active",
    version: 4,
    etag: `"${id}.4"`,
    createdAt: "2026-09-18T14:30:00.000Z",
    createdBy: "gallery-user",
    updatedAt: "2026-09-24T16:45:00.000Z",
    updatedBy: "gallery-user",
    ...overrides,
  };
}

const INITIAL_ASSETS: readonly MediaAssetSummary[] = [
  image("gallery-energy", "Offshore wind turbines, Barnegat Bay", energyImage, {
    altText: "Wind turbines and solar panels along Barnegat Bay.",
  }),
  image("gallery-statehouse", "Statehouse dome at dusk", domeImage),
  image("gallery-brand-guide", "NJ PBS brand guide", "#gallery-pdf-original", {
    originalName: "njpbs-brand-guide.pdf",
    tags: ["brand", "standards"],
    altText: null,
    mimeType: "application/pdf",
    kind: "document",
    sizeBytes: 2_862_100,
    width: null,
    height: null,
    thumbnails: undefined,
  }),
];

const galleryToken = async () => "gallery-token";

function saveLocally(
  asset: MediaAssetSummary,
  metadata: UpdateMediaMetadata,
): Promise<UpdateMediaMetadataResponse> {
  const version = asset.version + 1;
  return Promise.resolve({
    success: true,
    changed: true,
    asset: {
      ...asset,
      ...metadata,
      version,
      etag: `"${asset.id}.${version}"`,
      updatedAt: "2026-09-25T16:00:00.000Z",
    },
  });
}

function deleteLocally(asset: MediaAssetSummary): Promise<DeleteMediaResponse> {
  return Promise.resolve({
    success: true,
    changed: true,
    deleted: true,
    asset: {
      id: asset.id,
      lifecycle: "tombstoned",
      version: asset.version + 1,
      etag: `"${asset.id}.${asset.version + 1}"`,
    },
  });
}

/** The shipped full-size image viewer with local assets and local metadata actions. */
export function ImageViewerSpecimen() {
  const [assets, setAssets] = useState<readonly MediaAssetSummary[]>(() => new URLSearchParams(window.location.search).has("comparison")
    ? [...INITIAL_ASSETS,
      image("gallery-portrait", "Transparent portrait", "/comparison-portrait.svg", { mimeType: "image/svg+xml", width: 800, height: 1600 }),
      image("gallery-missing", "Unavailable preview", "/comparison-missing.svg")]
    : INITIAL_ASSETS);
  const [activeId, setActiveId] = useState(INITIAL_ASSETS[1].id);
  const [favorite, setFavorite] = useState(true);
  const current = assets.find((candidate) => candidate.id === activeId) ?? assets[0];
  const asset = new URLSearchParams(window.location.search).has("optimized")
    ? { ...current, mimeType: "image/webp", originalAvailable: true }
    : current;
  const navigationPrompt = new URLSearchParams(window.location.search).has("navigation-prompt") ? (
    <InlineMessage tone="warning" title="Unsaved media changes">
      <p>Leave this page without saving your changes?</p>
      <Button>Discard changes</Button>
      <Button>Keep editing</Button>
    </InlineMessage>
  ) : null;

  return (
    <ImageViewer
      asset={asset}
      getIdToken={new URLSearchParams(window.location.search).has("download-test") ? galleryToken : undefined}
      canEdit
      categories={CATEGORIES}
      deleteMedia={deleteLocally}
      favorite={{ favorite, name: asset.name, onToggle: () => setFavorite(current => !current) }}
      onClose={() => undefined}
      navigationPrompt={navigationPrompt}
      onDeleted={() => undefined}
      onDirtyChange={() => undefined}
      onReload={() => undefined}
      onSaved={(saved) => setAssets((current) => current.map((candidate) => (
        candidate.id === saved.id ? saved : candidate
      )))}
      onSavingChange={() => undefined}
      onStep={(next) => setActiveId(next.id)}
      pageTags={["legislature", "newark", "transportation"]}
      recentTags={["archive", "elections"]}
      saveMetadata={saveLocally}
      steppingOrder={assets}
    />
  );
}
