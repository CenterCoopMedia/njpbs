import { describe, expect, it } from "vitest";
import { estimateEditorConversionCharge } from "../src/lib/video-editor-exports";

describe("pre-request conversion price", () => {
  it("prices measured original SD, HD and 4K ProRes at the selected rate", () => {
    // Ohio Professional base $0.012/min; ProRes multipliers SD2/2.5, HD4/5, 4K8/10.
    expect(estimateEditorConversionCharge("prores_mov", "broadcast", 120, undefined, { width: 720, height: 480 }))
      .toEqual({ minimum: 0.048, maximum: 0.048 });
    expect(estimateEditorConversionCharge("prores_mov", "25/1", 120, undefined, { width: 1920, height: 1080 }))
      .toEqual({ minimum: 0.096, maximum: 0.096 });
    expect(estimateEditorConversionCharge("prores_mov", "60000/1001", 120, undefined, { width: 2160, height: 3840 }))
      .toEqual({ minimum: 0.24, maximum: 0.24 });
  });
  it("shows a source-size range without inferring the original size from the web copy", () => {
    expect(estimateEditorConversionCharge("prores_mov", "broadcast", 120))
      .toEqual({ minimum: 0.048, maximum: 0.192 });
    expect(estimateEditorConversionCharge("prores_mov", "source", 120))
      .toEqual({ minimum: 0.048, maximum: 0.24 });
  });
  it("keeps MP4 bounded at the HD estimate and does not price an unsupported ProRes tier", () => {
    expect(estimateEditorConversionCharge("broadcast_mp4", "broadcast", 120))
      .toEqual({ minimum: 0.048, maximum: 0.048 });
    expect(estimateEditorConversionCharge("prores_mov", "broadcast", 120, undefined, { width: 4096, height: 4096 })).toBeNull();
  });
});
