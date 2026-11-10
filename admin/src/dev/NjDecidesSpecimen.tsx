/** Local NJ Decides settings specimen. It has no authentication or network writes. */
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_NJ_DECIDES_SETTINGS,
  NJ_DECIDES_SETTINGS_ID,
  type NjDecidesSettingsValues,
} from "../../../packages/content-core/src/cms-settings";
import {
  NjDecidesSettings,
  type NjDecidesSettingsTransport,
} from "../components/NjDecidesSettings";
import type {
  CmsSettingsDocument,
  MediaAssetSummary,
  SettingsPublicationReceipt,
} from "../lib/functions";
import "../styles.css";
import "../cms-workspace.css";

const params = new URLSearchParams(location.search);
const specimenState = params.get("state") ?? "default";

const logo: MediaAssetSummary = {
  id: "fixture-logo",
  name: "Example campaign artwork",
  originalName: "campaign-art.webp",
  category: "general",
  categories: ["general"],
  tags: [],
  description: null,
  altText: "Example campaign artwork",
  license: "Local specimen",
  credit: null,
  mimeType: "image/webp",
  kind: "image",
  sizeBytes: 2_000,
  width: 457,
  height: 648,
  url: "/brand/auth-newsroom-art.webp",
  lifecycle: "active",
  version: 1,
  etag: "fixture-logo",
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
};

const background: MediaAssetSummary = {
  ...logo,
  id: "fixture-background",
  name: "Statehouse background",
  originalName: "statehouse.jpg",
  altText: "",
  mimeType: "image/jpeg",
  width: 640,
  height: 360,
  url: "/brand/auth-statehouse.jpg",
  etag: "fixture-background",
};

function initialValues(): NjDecidesSettingsValues {
  if (specimenState === "custom-color") {
    return {
      ...DEFAULT_NJ_DECIDES_SETTINGS,
      backgroundColor: "#011375",
      textColor: "#FFFFFF",
      linkColor: "#FFFFFF",
      ruleColor: "#8B0000",
      accentColor: "#FFFFFF",
    };
  }
  if (specimenState === "custom-image") {
    return {
      ...DEFAULT_NJ_DECIDES_SETTINGS,
      backgroundAssetId: background.id,
    };
  }
  return DEFAULT_NJ_DECIDES_SETTINGS;
}

function publicationReceipt(sourceVersion: number): SettingsPublicationReceipt {
  return {
    queueId: "fixture-publication",
    originalOperationId: "fixture-publication",
    transport: "public-context-no-build-v1",
    sourceVersion,
    rendererSha: "a".repeat(40),
    contextRevision: 1,
    contextDigest: "b".repeat(64),
    status: "success",
    missingConsumers: [],
  };
}

function Specimen() {
  const transport = useMemo<NjDecidesSettingsTransport>(() => {
    let version = 3;
    let values = initialValues();
    let published: CmsSettingsDocument<NjDecidesSettingsValues>["published"];
    let receipt: SettingsPublicationReceipt | undefined;
    const settings = (): CmsSettingsDocument<NjDecidesSettingsValues> => ({
      schemaVersion: 1,
      values,
      version,
      ...(published ? { published } : {}),
    });
    return {
      load: async () => ({
        success: true,
        found: true,
        id: NJ_DECIDES_SETTINGS_ID,
        settings: settings(),
        ...(receipt ? { publication: receipt } : {}),
      }),
      save: async (request) => {
        values = request.values as NjDecidesSettingsValues;
        version += 1;
        return {
          success: true,
          changed: true,
          id: NJ_DECIDES_SETTINGS_ID,
          settings: settings(),
        };
      },
      publish: async (request) => {
        published = {
          schemaVersion: 1,
          values,
          sourceVersion: request.baseVersion,
          publishedAt: "2026-10-26T16:00:00.000Z",
        };
        receipt = publicationReceipt(request.baseVersion);
        version += 1;
        return {
          success: true,
          changed: true,
          id: NJ_DECIDES_SETTINGS_ID,
          settings: settings(),
          publication: receipt,
        };
      },
      loadMedia: async (query) => {
        const records = [logo, background].filter(
          (asset) => !query.assetIds || query.assetIds.includes(asset.id),
        );
        return {
          success: true,
          records,
          total: records.length,
          allCount: records.length,
          page: 1,
          pageCount: 1,
          categoryCounts: { general: records.length },
          kindCounts: { image: records.length },
        };
      },
      mediaCategories: [{
        id: "general",
        label: "General",
        description: "Local fixture images.",
        order: 1,
        active: true,
        reserved: true,
        version: 1,
        etag: "fixture",
        canUpload: false,
        canManage: false,
        createdAt: null,
        createdBy: null,
        updatedAt: null,
        updatedBy: null,
      }],
      defaultUploadCategory: "general",
      canUploadCategory: () => false,
    };
  }, []);

  return <main className="admin-settings">
    <NjDecidesSettings {...transport} />
  </main>;
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById("nj-decides-root")!).render(<Specimen />);
}
