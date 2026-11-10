import { InfoTooltip } from "./ui/InfoTooltip";
import { mediaDisplayUrl, mediaImageSources } from "../lib/media-image";
import { useId, useRef, useState } from "react";
import { useMediaCategories } from "../lib/use-media-categories";
import { AsyncActionButton, Button, InlineMessage, TextInput } from "./ui/Primitives";
import {
  AUTHOR_PHOTO_ACCEPT,
  AUTHOR_PHOTO_BASIS_LABELS,
  AUTHOR_PHOTO_MIN_DIMENSION,
  authorPhotoMegabytes,
  authorPhotoRightsBasisForLicense,
  checkAuthorPhotoFile,
} from "../lib/author-photo";
import { FocalPointControl } from "./FocalPointControl";
import {
  AUTHOR_PROFILE_LIMITS,
  photoFormValueFromAsset,
  type AuthorPhotoFormValue,
} from "../lib/author-profile-form";
import {
  AUTHOR_PHOTO_RIGHTS_BASES,
  authorPhotoCreditRequired,
  checkAuthorPhotoAsset,
  type AuthorPhotoRightsBasis,
} from "../../../packages/content-core/src/author-profiles";
import type { MediaAssetSummary, MediaCategoryDefinition } from "../lib/functions";
import { MediaPickerDialog, type MediaPickerLoader } from "./MediaPickerDialog";
import {
  AUTHOR_PROFILE_RELEASE_COPY,
  authorPhotoActionCopy,
} from "../lib/author-profile-release";

// The photograph half of an author profile: choose a file, say what the right to
// publish it is, place the square crop, and save.
//
// Three decisions shape this surface.
//
// The attestation is a gate, not a footnote. Nothing uploads until someone has
// said which rights basis applies and ticked the confirmation, because a
// photograph of a real person goes onto a public page with no human review behind
// it. This checkbox and the server's automated checks validate that attestation.
//
// New bytes make a new immutable asset. Choosing an existing image, or uploading
// bytes the library already owns, reuses that asset instead of duplicating or
// replacing its binary. Removal withdraws the use rather than deleting the file,
// which is what keeps the tombstone fence meaningful.
//
// And the crop never re-encodes. Placing the focus stores two numbers and draws
// the same immutable library asset at every avatar size.

export interface AuthorPhotoFieldProps {
  value: AuthorPhotoFormValue | null;
  onChange: (value: AuthorPhotoFormValue | null) => void;
  /** Sends one file to the media library. Supplied by the route that has a token. */
  onUpload: (
    file: File,
    options: { rightsBasis: AuthorPhotoRightsBasis; credit: string },
  ) => Promise<MediaAssetSummary>;
  /**
   * Completes the profile attachment after the file reaches the media library.
   * When omitted, the caller keeps the ordinary two-step form behavior.
   */
  onUploaded?: (value: AuthorPhotoFormValue) => Promise<void>;
  /** Lists profile-photo assets the signed-in caller may attach. */
  loadMedia?: MediaPickerLoader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  disabled?: boolean;
  idPrefix: string;
  error?: string;
  /** Whose photograph this is, so the copy reads right on the admin surface. */
  subject: "self" | "other";
  subjectName?: string;
  /** Whether the stored profile has a published CMS snapshot. */
  profileIsPublished?: boolean;
}

function missingRightsNotice(asset: MediaAssetSummary): string {
  const recorded = asset.license?.trim()
    ? `The media library records its license as "${asset.license.trim()}".`
    : "The media library has no license for it.";
  return `This image has no staff photo rights record. ${recorded} Choose how NJ PBS may use it below. Your choice is saved with this profile.`;
}

function describeSize(value: AuthorPhotoFormValue): string | null {
  if (!value.width || !value.height) return null;
  return `${value.width} by ${value.height} pixels`;
}

export function AuthorPhotoField({
  value,
  onChange,
  onUpload,
  onUploaded,
  loadMedia,
  mediaCategories,
  disabled = false,
  idPrefix,
  error,
  subject,
  subjectName,
  profileIsPublished = false,
}: AuthorPhotoFieldProps) {
  const groupId = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<MediaAssetSummary | null>(
    null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const { state: categoryRegistry } = useMediaCategories(
    pickerOpen && mediaCategories === undefined,
  );
  const [basis, setBasis] = useState<AuthorPhotoRightsBasis | "">("");
  const [confirmed, setConfirmed] = useState(false);
  const [credit, setCredit] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [rightsNotice, setRightsNotice] = useState<string | null>(null);

  const id = (name: string) => `${idPrefix}-photo-${name}`;
  const who = subject === "self" ? "your" : `${subjectName ?? "this person"}'s`;

  function resetChooser(): void {
    setFile(null);
    setSelectedAsset(null);
    setPickerOpen(false);
    setBasis("");
    setConfirmed(false);
    setCredit("");
    setUploadError(null);
    setChoiceError(null);
    setRightsNotice(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function chooseFile(chosen: File | null): Promise<void> {
    setUploadError(null);
    setChoiceError(null);
    setRightsNotice(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    const check = await checkAuthorPhotoFile(chosen);
    if (!check.ok) {
      setFile(null);
      setChoiceError(check.error);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setSelectedAsset(null);
    setBasis("");
    setConfirmed(false);
    setCredit("");
    setFile(chosen);
  }

  function chooseExistingAsset(asset: MediaAssetSummary): void {
    // Type, size and dimensions still block, so say so before the profile save.
    const problems = asset.kind === "image"
      ? checkAuthorPhotoAsset(asset, asset.id)
      : ["That file is not an image"];
    if (problems.length > 0) {
      // Drop any earlier pending choice so "Use photo" cannot save it instead.
      resetChooser();
      setChoiceError(`That image cannot be a profile photo. ${problems.join(". ")}. Choose another image.`);
      return;
    }
    // A library image without a profile-photo license can still be used. The
    // rights choice made here is saved with the profile.
    const assetBasis = authorPhotoRightsBasisForLicense(asset.license);
    setRightsNotice(assetBasis === null ? missingRightsNotice(asset) : null);
    setFile(null);
    setSelectedAsset(asset);
    setBasis(assetBasis ?? "");
    setCredit(asset.credit ?? "");
    setConfirmed(false);
    setUploadError(null);
    setChoiceError(null);
    setPickerOpen(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  const creditRequired = basis !== "" && authorPhotoCreditRequired(basis);
  // A library image keeps its recorded basis. One without a profile-photo
  // license asks for the basis, like a new upload.
  const askBasis =
    selectedAsset === null ||
    authorPhotoRightsBasisForLicense(selectedAsset.license) === null;
  const readyToUse =
    (file !== null || selectedAsset !== null) &&
    basis !== "" &&
    confirmed &&
    (!creditRequired || credit.trim() !== "");

  async function usePhoto(): Promise<void> {
    if ((!file && !selectedAsset) || basis === "" || !confirmed) return;
    setUploading(true);
    setUploadError(null);
    try {
      const asset = file
        ? await onUpload(file, { rightsBasis: basis, credit })
        : selectedAsset;
      if (!asset) return;
      const storedBasis = authorPhotoRightsBasisForLicense(asset.license);
      if (file && storedBasis === null) {
        // The upload matched a library file without a profile-photo license.
        // Show what the library records, keep the chosen basis, and confirm again.
        setFile(null);
        setSelectedAsset(asset);
        setCredit(credit.trim() || (asset.credit ?? ""));
        setConfirmed(false);
        setRightsNotice(`This file is already in the media library. ${missingRightsNotice(asset)}`);
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      if (
        file &&
        storedBasis !== null &&
        (storedBasis !== basis ||
          (asset.credit ?? "").trim() !== credit.trim())
      ) {
        setFile(null);
        setSelectedAsset(asset);
        setBasis(storedBasis);
        setCredit(asset.credit ?? "");
        setConfirmed(false);
        setChoiceError(
          "This image is already in the media library with different rights details. Review them and confirm again.",
        );
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      const selectedPhoto = photoFormValueFromAsset(
        asset,
        basis,
        credit.trim(),
      );
      const nextPhoto = asset.id === value?.assetId
        ? {
            ...selectedPhoto,
            focalX: value.focalX,
            focalY: value.focalY,
          }
        : selectedPhoto;
      if (onUploaded) await onUploaded(nextPhoto);
      else onChange(nextPhoto);
      resetChooser();
    } catch (uploadFailure) {
      setUploadError(
        uploadFailure instanceof Error && uploadFailure.message
          ? uploadFailure.message
          : "That photo could not be used. Try again.",
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <section aria-labelledby={`${groupId}-heading`} className="author-photo">
      <h3 className="author-photo-heading" id={`${groupId}-heading`} aria-label="Profile photo">
        Profile photo
        <InfoTooltip label="Profile photo" content={`${AUTHOR_PROFILE_RELEASE_COPY.photoDescription(who)} Use a JPEG, PNG, WebP or AVIF image at least ${AUTHOR_PHOTO_MIN_DIMENSION} pixels on each side and under ${authorPhotoMegabytes()} MB. You must confirm the photo rights before it uploads. Removing takes the photo off ${who} profile when you save. The file stays in the media library.`} />
      </h3>

      {error ? (
        <p className="field-error" id={id("error")}>
          {error}
        </p>
      ) : null}

      <div className="author-photo-editor">
        {value ? (
          <div className="author-photo-placement">
            <FocalPointControl
              disabled={disabled}
              onChange={({ x, y }) => onChange({ ...value, focalX: x, focalY: y })}
              src={mediaDisplayUrl(value, 288, 288)}
              value={{ x: value.focalX, y: value.focalY }}
            />
            <p className="field-hint">
              This preview shows the square crop for the public profile.
              {describeSize(value) ? ` Original: ${describeSize(value)}.` : ""}
            </p>
          </div>
        ) : (
          <div className="author-photo-empty">
            <span>No photo selected</span>
          </div>
        )}

        <div className="author-photo-chooser">
          <div className="author-profile-actions author-photo-source-actions">
            {loadMedia ? (
              <Button
                disabled={disabled || uploading}
                onClick={() => setPickerOpen(true)}
                variant="secondary"
              >
                Choose from media library
              </Button>
            ) : null}
            <Button
              disabled={disabled || uploading}
              onClick={() => fileInput.current?.click()}
              variant="secondary"
            >
              {file
                ? "Choose another file"
                : value
                  ? "Replace photo"
                  : "Upload a photo"}
            </Button>
            {value ? (
              <Button
                disabled={disabled}
                onClick={() => onChange(null)}
                variant="ghost"
              >
                Remove photo
              </Button>
            ) : null}
          </div>
          <input
            accept={AUTHOR_PHOTO_ACCEPT}
            aria-describedby={id("file-hint")}
            aria-label={value ? "Replace with a different photo" : "Choose a photo"}
            className="sr-only"
            disabled={disabled || uploading}
            id={id("file")}
            onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)}
            ref={fileInput}
            type="file"
          />
          <p className="sr-only" id={id("file-hint")}>
            Use a JPEG, PNG, WebP or AVIF image at least {AUTHOR_PHOTO_MIN_DIMENSION}{" "}
            pixels on each side and under {authorPhotoMegabytes()} MB. You must
            confirm the photo rights before it uploads.
          </p>

          {value ? (
            <div className="author-photo-controls">
              <div className="author-profile-field">
                <div className="editor-field-label-row"><label htmlFor={id("credit")}>
                  Photo credit
                  {authorPhotoCreditRequired(value.rightsBasis) ? (
                    <span aria-hidden="true"> *</span>
                  ) : null}
                </label>
                <InfoTooltip label="Photo credit" content={authorPhotoCreditRequired(value.rightsBasis) ? "Required for a licensed photo. Stored with the photo." : "Optional. Stored with the photo when you add one."} />
                </div>
                <p className="sr-only" id={id("credit-hint")}>
                  {authorPhotoCreditRequired(value.rightsBasis)
                    ? "Required for a licensed photo. Stored with the photo."
                    : "Optional. Stored with the photo when you add one."}
                </p>
                <TextInput
                  aria-describedby={
                    [id("credit-hint"), error ? id("error") : null]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  disabled={disabled}
                  id={id("credit")}
                  maxLength={AUTHOR_PROFILE_LIMITS.photoCredit}
                  onChange={(event) =>
                    onChange({ ...value, credit: event.target.value })
                  }
                  value={value.credit}
                />
              </div>

              <p className="field-hint">
                Rights: {AUTHOR_PHOTO_BASIS_LABELS[value.rightsBasis].label}.
              </p>

            </div>
          ) : null}

          {choiceError ? (
            <p className="field-error" role="alert">
              {choiceError}
            </p>
          ) : null}

          {rightsNotice ? (
            <InlineMessage tone="warning">{rightsNotice}</InlineMessage>
          ) : null}

          {file || selectedAsset ? (
            <>
            {selectedAsset ? (
              <div className="author-photo-preview">
                <img
                  alt=""
                  className="author-photo-preview-image"
                  {...mediaImageSources(selectedAsset, 960)}
                  loading="lazy"
                  decoding="async"
                />
                <p className="field-hint">
                  Selected from the media library: {selectedAsset.name}.
                </p>
                {basis && !askBasis ? (
                  <p className="field-hint">
                    Rights: {AUTHOR_PHOTO_BASIS_LABELS[basis].label}.
                  </p>
                ) : null}
              </div>
            ) : null}
            {askBasis ? (
              <fieldset className="author-photo-rights" disabled={disabled || uploading}>
                <legend>
                  How may NJ PBS use this photo? <span aria-hidden="true">*</span>
                </legend>
                {AUTHOR_PHOTO_RIGHTS_BASES.map((option) => (
                  <div className="author-photo-rights-option" key={option}>
                    <input
                      checked={basis === option}
                      id={id(`basis-${option}`)}
                      name={id("basis")}
                      onChange={() => setBasis(option)}
                      type="radio"
                      value={option}
                    />
                    <div className="editor-field-label-row"><label htmlFor={id(`basis-${option}`)}>
                      {AUTHOR_PHOTO_BASIS_LABELS[option].label}
                    </label><InfoTooltip label={AUTHOR_PHOTO_BASIS_LABELS[option].label} content={AUTHOR_PHOTO_BASIS_LABELS[option].description} /></div>
                  </div>
                ))}
              </fieldset>
            ) : null}

            {creditRequired ? (
              <div className="author-profile-field">
                <label htmlFor={id("new-credit")}>
                  Photographer's credit <span aria-hidden="true">*</span>
                </label>
                <TextInput
                  disabled={disabled || uploading}
                  id={id("new-credit")}
                  maxLength={AUTHOR_PROFILE_LIMITS.photoCredit}
                  onChange={(event) => setCredit(event.target.value)}
                  value={credit}
                />
              </div>
            ) : null}

            <div className="author-photo-attest">
              <input
                checked={confirmed}
                disabled={disabled || uploading}
                id={id("attest")}
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              <label htmlFor={id("attest")}>
                I confirm NJ PBS may publish this photo
                {subject === "self" ? "" : " of this person"}, and that the person
                shown agreed to it. <span aria-hidden="true">*</span>
              </label>
            </div>

            {uploadError ? (
              <InlineMessage tone="error">{uploadError}</InlineMessage>
            ) : null}

            <div className="author-profile-actions">
              <AsyncActionButton
                disabled={!readyToUse}
                label={
                  selectedAsset
                    ? onUploaded
                      ? "Use and save photo"
                      : "Use photo"
                    : onUploaded
                      ? "Upload and save photo"
                      : "Upload photo"
                }
                onClick={() => void usePhoto()}
                pending={uploading}
                pendingAnnouncement={
                  selectedAsset
                    ? onUploaded
                      ? "Using and saving the photo."
                      : "Using the photo."
                    : onUploaded
                      ? "Uploading and saving the photo."
                      : "Uploading the photo."
                }
                pendingLabel={
                  selectedAsset
                    ? onUploaded
                      ? "Using and saving…"
                      : "Using…"
                    : onUploaded
                      ? "Uploading and saving…"
                      : "Uploading…"
                }
                variant="secondary"
              />
              <Button
                disabled={uploading}
                onClick={resetChooser}
                variant="ghost"
              >
                Cancel this choice
              </Button>
            </div>
            <p className="field-hint">
              {authorPhotoActionCopy({
                assetSource: selectedAsset ? "library" : "upload",
                profileIsPublished,
                saveMode: onUploaded ? "immediate" : "profile-save",
                subject,
              })}
            </p>
            </>
          ) : null}
        </div>
      </div>
      {pickerOpen && loadMedia ? (
        <MediaPickerDialog
          destination="Profile photo"
          currentAssetId={value?.assetId ?? ""}
          loadMedia={loadMedia}
          categories={mediaCategories ?? categoryRegistry.categories}
          onClose={() => setPickerOpen(false)}
          onSelect={chooseExistingAsset}
        />
      ) : null}
    </section>
  );
}
