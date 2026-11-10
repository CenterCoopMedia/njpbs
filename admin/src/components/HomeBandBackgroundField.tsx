import type { ComponentProps } from "react";
import type { AdminBlock } from "../lib/block-factory";
import { FieldRenderer } from "./FieldRenderer";

type MediaProps = Pick<ComponentProps<typeof FieldRenderer>, "loadMedia" | "mediaPickerUnavailable" | "uploadMedia" | "mediaCategories" | "defaultUploadCategory" | "canUploadCategory" | "onMediaPickerDirtyChange">;

export function HomeBandBackgroundField({ block, readOnly, onChange, ...media }: MediaProps & {
  block: AdminBlock; readOnly: boolean; onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
}) {
  return <fieldset disabled={readOnly}>
    <FieldRenderer {...media} field={{ key: "backgroundImageAssetId", label: "Background image", kind: "asset", required: false,
      help: "Choose decorative artwork from the media library. Remove the image to restore this section's default. Keep important information in the text." }}
      fieldId={`home-band-background-${block.id}`} value={block.data.backgroundImageAssetId ?? ""}
      onChange={value => { if (!readOnly) onChange({ ...block.data, backgroundImageAssetId: String(value ?? "") }, true); }} />
  </fieldset>;
}
