import { isDataFigureData, type DataFigureData } from "./data-figure.ts";
import { isVideoBlockData, type VideoBlockData } from "./video-block.ts";

export const SCROLL_STORY_LIMITS = { steps: 12, text: 1200, alt: 300, caption: 600 } as const;

export interface ScrollStoryStep {
  text: string;
  assetId: string;
  alt: string;
  caption: string;
  video?: VideoBlockData;
  figure?: DataFigureData;
}

export interface ScrollStoryData {
  steps: ScrollStoryStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isScrollStoryData(data: Record<string, unknown>, complete: boolean): boolean {
  return Reflect.ownKeys(data).every(key => key === "steps")
    && Array.isArray(data.steps)
    && data.steps.length >= (complete ? 1 : 0)
    && data.steps.length <= SCROLL_STORY_LIMITS.steps
    && data.steps.every(step => {
      if (!isRecord(step)
        || !Reflect.ownKeys(step).every(key => key === "text" || key === "assetId" || key === "alt"
          || key === "caption" || key === "video" || key === "figure")
        || typeof step.text !== "string" || step.text.length > SCROLL_STORY_LIMITS.text
        || typeof step.assetId !== "string" || !/^[A-Za-z0-9_-]{0,128}$/.test(step.assetId)
        || typeof step.alt !== "string" || step.alt.length > SCROLL_STORY_LIMITS.alt
        || typeof step.caption !== "string" || step.caption.length > SCROLL_STORY_LIMITS.caption
        || (complete && !step.text.trim())) return false;
      if (step.video === undefined && step.figure === undefined) {
        return !complete || !step.assetId || Boolean(step.alt.trim());
      }
      if (step.assetId || step.alt || step.caption) return false;
      if (step.video !== undefined) {
        return step.figure === undefined && isVideoBlockData(step.video, complete)
          && /^[A-Za-z0-9_-]{0,128}$/.test(step.video.assetId);
      }
      return isDataFigureData(step.figure, complete);
    });
}

export function scrollStoryMediaError(steps: unknown): string | null {
  if (!Array.isArray(steps)) return null;
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step)) continue;
    if (isVideoBlockData(step.video, false)) {
      if (!step.video.assetId) return `Choose a video for step ${index + 1}.`;
      if (!step.video.title.trim()) return `Enter a video title for step ${index + 1}.`;
    }
    if (isDataFigureData(step.figure) && !isDataFigureData(step.figure, true)) {
      return `Choose an approved dataset release for step ${index + 1}.`;
    }
  }
  return null;
}

/** The frozen snapshot includes the step order, so its positions identify nested figures. */
export function scrollStoryFigureId(blockId: string, stepIndex: number): string {
  return `scroll-figure-${blockId}-${stepIndex + 1}`;
}

/** Figure selection slots in one block. Callers apply their own layout visibility. */
export function figureSelections(block: unknown): Array<{ id: string; data: unknown }> {
  if (!isRecord(block) || typeof block.id !== "string") return [];
  if (block.type === "data_figure") return [{ id: block.id, data: block.data }];
  if (block.type !== "scroll_story" || !isRecord(block.data) || !Array.isArray(block.data.steps)) return [];
  const blockId = block.id;
  return block.data.steps.flatMap((step, index) =>
    isRecord(step) && typeof step.text === "string" && step.text.trim() && step.figure !== undefined
      ? [{ id: scrollStoryFigureId(blockId, index), data: step.figure }]
      : []);
}
