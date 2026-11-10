import { useCoverageLabels } from "../context/CoverageLabelsContext";
import { Button } from "./ui/Primitives";

/** A missing registry must not look like a confirmed label-free card preview. */
export function CoverageLabelPreviewStatus() {
  const { status, request } = useCoverageLabels(false);
  if (status === "ready") return null;
  return <div role="status"><p>{status === "idle" || status === "loading" ? "Loading coverage labels for this preview…"
    : "Coverage labels are unavailable in this layout preview. Your draft is unchanged; use the saved page preview to verify them."}</p>
    {status === "error" ? <Button onClick={() => request(true)}>Retry coverage labels</Button> : null}</div>;
}
