import { postFunction } from "./functions";
import { sourceFramesPerSecond, type SourceFrameRate } from "./video-frame-rate";
import type { VideoClip, VideoIdentity } from "./video-production";

export const editorFormats = {
  broadcast_mp4: { label: "MP4 / Frame rate copy", extension: "mp4" },
  broadcast_mxf: { label: "MXF / XDCAM HD422", extension: "mxf" },
  prores_mov: { label: "MOV / ProRes 422 HQ", extension: "mov" },
  avid_mxf: { label: "MXF / DNxHD", extension: "mxf" },
} as const;
export type EditorFormat = keyof typeof editorFormats;
export const exportFrameRates = { broadcast: "29.97 fps (30000/1001)", source: "Keep source frame rate",
  "24000/1001": "23.976 fps (24000/1001)", "24/1": "24 fps (24/1)", "25/1": "25 fps (25/1)",
  "30/1": "30 fps (30/1)", "50/1": "50 fps (50/1)", "60000/1001": "59.94 fps (60000/1001)", "60/1": "60 fps (60/1)" } as const;
export type ExportFrameRateMode = keyof typeof exportFrameRates;
export function exportFramesPerSecond(mode: ExportFrameRateMode, sourceRate?: SourceFrameRate) {
  if (mode === "source") return sourceFramesPerSecond(sourceRate);
  if (mode === "broadcast") return 30000 / 1001;
  const [n, d] = mode.split("/").map(Number);
  return n / d;
}
export function exportFrameRateLabel(mode?: ExportFrameRateMode | null) {
  return exportFrameRates[mode ?? "source"];
}
export function exportRateSupported(format: EditorFormat, mode: ExportFrameRateMode) {
  return format !== "broadcast_mxf" || !["24/1", "30/1", "60/1"].includes(mode);
}
export type EditorExportScope = "clip" | "source";
export type EditorVideoExport = Omit<VideoClip, "durationMs"> & {
  attemptId: string;
  format: EditorFormat;
  scope: EditorExportScope;
  durationMs: number | null;
  canCancel?: boolean;
  audioChannels?: number | null;
  audioTracks?: number | null;
  frameRateMode?: ExportFrameRateMode | null;
  requestedFrameRate?: string;
  sourceFrameRateNumerator?: number | null;
  sourceFrameRateDenominator?: number | null;
  conversionMethod?: "none" | "interpolate" | "telecine" | null;
  timecodeMode?: "embedded_or_zero_based" | "zero_based" | null;
  frameRateNumerator?: number | null;
  frameRateDenominator?: number | null;
};
export type EditorExportRequest = {
  format: EditorFormat;
  retry?: boolean;
  frameRateMode?: ExportFrameRateMode;
} & ({ scope: "clip"; inMs: number; outMs: number } | { scope: "source" });

export function requestEditorExport(token: string, identity: VideoIdentity, request: EditorExportRequest) {
  return postFunction<{ success: true; clip: EditorVideoExport }>(
    "cmsRequestVideoClip", token, { ...identity, ...request }, {}, { appCheck: true });
}
export function listEditorExports(token: string, identity: VideoIdentity, scope: EditorExportScope, cursor?: string) {
  return postFunction<{ success: true; clips: EditorVideoExport[]; editorExportsEnabled?: boolean; nextCursor?: string | null }>(
    "cmsGetVideoClip", token, { ...identity, scope, ...(cursor ? { cursor } : {}) }, {}, { appCheck: true });
}
export function getEditorExport(token: string, identity: VideoIdentity, clipId: string) {
  return postFunction<{ success: true; clip: EditorVideoExport; editorExportsEnabled?: boolean }>(
    "cmsGetVideoClip", token, { ...identity, clipId }, {}, { appCheck: true });
}
export function cancelEditorExport(token: string, identity: VideoIdentity, clip: EditorVideoExport) {
  return postFunction<{ success: true; clip: EditorVideoExport }>(
    "cmsCancelVideoClip", token, { ...identity, clipId: clip.id, attemptId: clip.attemptId }, {}, { appCheck: true });
}

export interface OriginalVideoDimensions { width: number; height: number }

// Ohio Professional single-pass/HQ, checked 2026-10-05 against AWS pricing.
// Original dimensions must come from the original, never the downsized viewing copy.
export function estimateEditorConversionCharge(format: EditorFormat, mode: ExportFrameRateMode,
  durationSeconds: number, sourceRate?: SourceFrameRate, originalDimensions?: OriginalVideoDimensions) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  let tiers = [format === "broadcast_mxf" || format === "broadcast_mp4" ? [0.024, 0.03] : [0.048, 0.06]];
  if (format === "prores_mov") {
    const proresTiers = [[0.024, 0.03], [0.048, 0.06], [0.096, 0.12]];
    if (originalDimensions) {
      const { width, height } = originalDimensions;
      if (![width, height].every(value => Number.isSafeInteger(value) && value > 0) || Math.min(width, height) > 2160) return null;
      const shortSide = Math.min(width, height);
      tiers = [proresTiers[shortSide < 720 ? 0 : shortSide <= 1080 ? 1 : 2]];
    } else tiers = proresTiers;
  }
  const fps = exportFramesPerSecond(mode, sourceRate);
  const rates = tiers.flatMap(pair => fps === null ? pair : [pair[fps <= 30 ? 0 : 1]]);
  const minutes = Math.max(10, Math.ceil(durationSeconds)) / 60;
  return { minimum: minutes * Math.min(...rates), maximum: minutes * Math.max(...rates) };
}
