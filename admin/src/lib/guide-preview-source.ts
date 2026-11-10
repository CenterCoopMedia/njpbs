/** An explicit read-only transport supplied by a separately protected preview entry. */
export type GuidePreviewLoader = (signal: AbortSignal) => Promise<unknown>;

/** Both datasets stay behind the preview's transport; election loading remains lazy. */
export interface PoliticsPreviewSource {
  politics: GuidePreviewLoader;
  elections: GuidePreviewLoader;
}
