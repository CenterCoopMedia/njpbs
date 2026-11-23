import type { MediaMetadataBounds } from "../../lib/media-browse-metadata";
import type { VideoMediaLocationQuery } from "../../lib/media-query";
import { metadataFilterProperties, type MediaFilterPropertyModel } from "./MediaFilterPopover";

interface VideoFilterPropertiesOptions {
  tagOptions: readonly string[];
  tag: Pick<NonNullable<MediaFilterPropertyModel["text"]>, "value" | "error" | "onChange">;
  uploaderNames: ReadonlyMap<string, string>;
  userId: string;
  applyRange: (bounds: MediaMetadataBounds) => void;
}

export function videoFilterProperties(
  query: VideoMediaLocationQuery,
  { tagOptions, tag, uploaderNames, userId, applyRange }: VideoFilterPropertiesOptions,
): MediaFilterPropertyModel[] {
  const rights = [{ value: "pending", label: "Needs review" }, { value: "complete", label: "Rights recorded" }];
  const uploaders = [{ value: userId, label: "Me" },
    ...[...uploaderNames].filter(([id]) => id !== userId).map(([value, label]) => ({ value, label }))];
  return [
    {
      id: "tag", label: "Tag", picker: "text", appliedCount: query.tag ? 1 : 0,
      options: tagOptions.map(value => ({ value, label: value, selected: query.tag === value })),
      hint: "Enter an exact tag or choose one from this page or your recent tags.",
      text: { ...tag, placeholder: "Enter an exact tag", maxLength: 80 },
    },
    {
      id: "rights", label: "Rights review", picker: "options", appliedCount: query.rights ? 1 : 0,
      options: rights.map(option => ({ ...option, selected: query.rights === option.value })),
    },
    {
      id: "by", label: "Uploader", picker: "options", appliedCount: query.by ? 1 : 0,
      options: uploaders.map(option => ({ ...option, selected: query.by === option.value })),
    },
    ...metadataFilterProperties(query, { duration: true, aspect: true, requested: query.metadata === "requested", applyRange }),
  ];
}
