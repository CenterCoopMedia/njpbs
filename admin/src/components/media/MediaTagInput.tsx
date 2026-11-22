import { useContext, useId, useState, useSyncExternalStore } from "react";
import { mediaCacheIdentityRevision, subscribeMediaCacheIdentity } from "../../lib/media-session-cache";
import { MEDIA_TAG_LIMITS, mediaTagSuggestionPool, tagsToTokens } from "../../lib/media-tags";
import type { MediaTileSurface } from "../../lib/media-tile-actions";
import { loadSharedMediaTags, MediaTagTokenContext } from "../../lib/shared-media-tags";
import { TokenInput, type TokenInputProps } from "../ui/TokenInput";
import { splitEntry } from "../ui/tokenInputModel";

type MediaTagInputProps = Omit<TokenInputProps, "label" | "maxLength" | "maxCount" | "suggestions" | "suggestionsNote" | "onFocus"> & {
  surface: MediaTileSurface;
  localTags?: readonly string[];
};

function subscribeIdentity(listener: () => void) {
  return subscribeMediaCacheIdentity(() => queueMicrotask(listener));
}

export function MediaTagInput({ surface, localTags = [], ...props }: MediaTagInputProps) {
  const getIdToken = useContext(MediaTagTokenContext);
  const revision = useSyncExternalStore(subscribeIdentity, mediaCacheIdentityRevision);
  const [sample, setSample] = useState<{ revision: number; tags: string[] }>();
  const sharedTags = getIdToken && sample?.revision === revision ? sample.tags : [];
  const { maxLength, maxCount } = MEDIA_TAG_LIMITS[surface];
  const localNote = props.promoteMixed
    ? "From the selected items, this page and your recent tags."
    : "From this page and your recent tags.";

  return <TokenInput
    {...props}
    label="Tags"
    announceSuggestions={localTags.length > 0 || sample?.revision === revision}
    maxLength={maxLength}
    maxCount={props.promoteMixed ? undefined : maxCount}
    suggestions={mediaTagSuggestionPool(surface, localTags, sharedTags)}
    suggestionsNote={sharedTags.length ? "From saved media." : localNote}
    onFocus={() => {
      if (!getIdToken) return;
      void loadSharedMediaTags(getIdToken, revision).then(tags => {
        if (mediaCacheIdentityRevision() === revision) setSample({ revision, tags });
      });
    }}
  />;
}

// Upload queues store a comma-separated draft. Keep the unfinished entry in it so
// upload still saves a manually typed tag even if the editor skips Enter.
export function MediaUploadTagInput({ surface, value, disabled, onUpdate }: {
  surface: MediaTileSurface;
  value: string;
  disabled: boolean;
  onUpdate: (update: (value: string) => string) => void;
}) {
  const id = useId();
  const { complete, rest } = splitEntry(value);
  return <div className="media-upload-tag-field">
    <label htmlFor={id}>Tags</label>
    <MediaTagInput
      inputId={id}
      surface={surface}
      disabled={disabled}
      tokens={tagsToTokens(complete.map(tag => tag.trim()).filter(Boolean))}
      draft={rest}
      onChange={tokens => onUpdate(previous => [...tokens.map(token => token.value), splitEntry(previous).rest].join(","))}
      onDraftChange={draft => onUpdate(previous => [...splitEntry(previous).complete, draft].join(","))}
    />
  </div>;
}
