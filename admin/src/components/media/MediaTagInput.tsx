import { useContext, useId, useState, useSyncExternalStore } from "react";
import { mediaCacheIdentityRevision, subscribeMediaCacheIdentity } from "../../lib/media-session-cache";
import { EMPTY_UPLOAD_MEDIA_TAGS, MEDIA_TAG_LIMITS, mediaTagSuggestionPool, tagsToTokens, tokensToTags, type UploadMediaTagDraft } from "../../lib/media-tags";
import type { MediaTileSurface } from "../../lib/media-tile-actions";
import { loadSharedMediaTags, MediaTagTokenContext } from "../../lib/shared-media-tags";
import { TokenInput, type TokenInputProps } from "../ui/TokenInput";

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

// Only committed values become chips. Refused or unfinished text remains editable.
export function MediaUploadTagInput({ surface, value = EMPTY_UPLOAD_MEDIA_TAGS, disabled, onUpdate }: {
  surface: MediaTileSurface;
  value?: UploadMediaTagDraft;
  disabled: boolean;
  onUpdate: (patch: Partial<UploadMediaTagDraft>) => void;
}) {
  const id = useId();
  return <div className="media-upload-tag-field">
    <label htmlFor={id}>Tags</label>
    <MediaTagInput
      inputId={id}
      surface={surface}
      disabled={disabled}
      tokens={tagsToTokens(value.committed ? value.committed.split(",") : [])}
      draft={value.draft}
      onChange={tokens => onUpdate({ committed: tokensToTags(tokens).join(",") })}
      onDraftChange={draft => onUpdate({ draft })}
    />
  </div>;
}
