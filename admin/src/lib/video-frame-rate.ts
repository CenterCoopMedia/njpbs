export interface SourceFrameRate {
  sourceFrameRateNumerator?: number | null;
  sourceFrameRateDenominator?: number | null;
}
export function sourceFramesPerSecond(rate?: SourceFrameRate) {
  const n = rate?.sourceFrameRateNumerator;
  const d = rate?.sourceFrameRateDenominator;
  return typeof n === "number" && typeof d === "number" && n > 0 && d > 0 ? n / d : null;
}
export function isBroadcastFrameRate(rate?: SourceFrameRate) {
  return sourceFramesPerSecond(rate) !== null && rate!.sourceFrameRateNumerator! * 1001 === rate!.sourceFrameRateDenominator! * 30000;
}
export function sourceFrameRateLabel(rate?: SourceFrameRate) {
  const fps = sourceFramesPerSecond(rate);
  return fps === null ? "Not measured" : `${Number(fps.toFixed(3))} fps (${rate!.sourceFrameRateNumerator}/${rate!.sourceFrameRateDenominator})`;
}
