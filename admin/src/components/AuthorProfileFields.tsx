import { InfoTooltip } from "./ui/InfoTooltip";
import { TextInput, Textarea } from "./ui/Primitives";
import { AuthorAvatar } from "./ui/AuthorAvatar";
import { AuthorPhotoField } from "./AuthorPhotoField";
import { normalizeSocialLink, type AuthorPhotoRightsBasis } from "../../../packages/content-core/src/author-profiles";
import type { MediaAssetSummary, MediaCategoryDefinition } from "../lib/functions";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import {
  AUTHOR_PLATFORMS,
  AUTHOR_PROFILE_LIMITS,
  PLATFORM_LABELS,
  type AuthorProfileFieldName,
  type AuthorProfileFormValues,
  type AuthorPhotoFormValue,
} from "../lib/author-profile-form";

// The editable half of an author profile, shared by the author's own page and the admin
// surface. One component means an admin edits exactly the fields the author does, under
// the same bounds and the same messages -- a second, drifting copy of this form would be
// how an admin ends up able to set something an author cannot.

export interface AuthorProfileFieldsProps {
  values: AuthorProfileFormValues;
  onChange: (values: AuthorProfileFormValues) => void;
  errors: Partial<Record<AuthorProfileFieldName, string>>;
  disabled?: boolean;
  /** Distinguishes the ids when two profile forms are on one page. */
  idPrefix: string;
  /**
   * Sends one profile photograph to the media library. Supplied by the route,
   * which is where the caller's token lives. Omitting it hides the photo section
   * rather than showing a control that cannot work.
   */
  onPhotoUpload?: (
    file: File,
    options: { rightsBasis: AuthorPhotoRightsBasis; credit: string },
  ) => Promise<MediaAssetSummary>;
  /** Saves a newly uploaded photo immediately instead of leaving it unsaved. */
  onPhotoUploaded?: (value: AuthorPhotoFormValue) => Promise<void>;
  loadPhotoMedia?: MediaPickerLoader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  /** Whose profile this is, so the photo copy reads right on both surfaces. */
  photoSubject?: "self" | "other";
  photoSubjectName?: string;
  photoProfileIsPublished?: boolean;
}

export function AuthorProfileFields({
  values,
  onChange,
  errors,
  disabled = false,
  idPrefix,
  onPhotoUpload,
  onPhotoUploaded,
  loadPhotoMedia,
  mediaCategories,
  photoSubject = "self",
  photoSubjectName,
  photoProfileIsPublished = false,
}: AuthorProfileFieldsProps) {
  function fieldId(name: string): string {
    return `${idPrefix}-${name}`;
  }

  function errorId(name: AuthorProfileFieldName): string | undefined {
    return errors[name] ? `${fieldId(name)}-error` : undefined;
  }

  function fieldError(name: AuthorProfileFieldName) {
    const message = errors[name];
    if (!message) return null;
    return (
      <p className="field-error" id={`${fieldId(name)}-error`}>
        {message}
      </p>
    );
  }

  return (
    <>
      <section className="author-profile-section" aria-labelledby={fieldId("identity-heading")}>
        <h3 id={fieldId("identity-heading")}>Identity</h3>
        <div className="author-profile-identity-fields">
          <div className="author-profile-field">
            <label htmlFor={fieldId("displayName")}>
              Public name <span aria-hidden="true">*</span>
            </label>
            <TextInput
              aria-describedby={errorId("displayName")}
              aria-invalid={errors.displayName ? true : undefined}
              disabled={disabled}
              id={fieldId("displayName")}
              maxLength={AUTHOR_PROFILE_LIMITS.displayName}
              onChange={(event) =>
                onChange({ ...values, displayName: event.target.value })
              }
              required
              value={values.displayName}
            />
            {fieldError("displayName")}
          </div>

          <div className="author-profile-field">
            <label htmlFor={fieldId("jobTitle")}>Job title</label>
            <TextInput
              aria-describedby={errorId("jobTitle")}
              aria-invalid={errors.jobTitle ? true : undefined}
              disabled={disabled}
              id={fieldId("jobTitle")}
              maxLength={AUTHOR_PROFILE_LIMITS.jobTitle}
              onChange={(event) => onChange({ ...values, jobTitle: event.target.value })}
              value={values.jobTitle}
            />
            {fieldError("jobTitle")}
          </div>

          <div className="author-profile-field">
            <label htmlFor={fieldId("bio")}>Short bio</label>
            <Textarea
              aria-describedby={errorId("bio")}
              aria-invalid={errors.bio ? true : undefined}
              disabled={disabled}
              id={fieldId("bio")}
              onChange={(event) => onChange({ ...values, bio: event.target.value })}
              rows={5}
              value={values.bio}
            />
            <p className="field-hint" aria-live="polite">
              {values.bio.trim().length} of {AUTHOR_PROFILE_LIMITS.bio} characters
              used.
            </p>
            {fieldError("bio")}
          </div>

        </div>
      </section>

      {onPhotoUpload ? (
        <AuthorPhotoField
          disabled={disabled}
          error={errors.photo}
          idPrefix={idPrefix}
          loadMedia={loadPhotoMedia}
          mediaCategories={mediaCategories}
          onChange={(photo) => onChange({ ...values, photo })}
          onUpload={onPhotoUpload}
          onUploaded={onPhotoUploaded}
          subject={photoSubject}
          subjectName={photoSubjectName}
          profileIsPublished={photoProfileIsPublished}
          value={values.photo}
        />
      ) : null}

      <section className="author-profile-section" aria-labelledby={fieldId("social-heading")}>
        <div className="editor-field-label-row"><h3 id={fieldId("social-heading")}>Social links</h3><InfoTooltip label="Social links" content="Only add public profiles you want readers to visit." /></div>
        <div className="author-profile-social-grid">
          {AUTHOR_PLATFORMS.map((platform) => {
            const label = PLATFORM_LABELS[platform];
            return (
              <fieldset
                className="author-profile-social"
                disabled={disabled}
                key={platform}
              >
                <legend>{label}</legend>
                <div className="author-profile-field">
                  <label className="sr-only" htmlFor={fieldId(`${platform}-url`)}>
                    {label} profile link
                  </label>
                  <TextInput
                    aria-describedby={errorId(platform)}
                    aria-invalid={errors[platform] ? true : undefined}
                    id={fieldId(`${platform}-url`)}
                    inputMode="url"
                    onChange={(event) =>
                      onChange({
                        ...values,
                        links: {
                          ...values.links,
                          [platform]: {
                            url: event.target.value,
                          },
                        },
                      })
                    }
                    value={values.links[platform].url}
                  />
                </div>
                {fieldError(platform)}
              </fieldset>
            );
          })}
        </div>
      </section>
    </>
  );
}


export function AuthorProfilePreview({ values }: { values: AuthorProfileFormValues }) {
  return (
    <section className="author-profile-preview" aria-label="Profile preview">
      <h3>Profile preview</h3>
      <div className="author-profile-preview-card">
        <AuthorAvatar
          className="author-profile-preview-photo"
          displayName={values.displayName}
          photo={values.photo}
        />
        <strong>{values.displayName.trim() || "Your public name"}</strong>
        {values.jobTitle.trim() ? <span>{values.jobTitle}</span> : null}
        {values.bio.trim() ? <p>{values.bio}</p> : <p className="field-hint">Your short bio will appear here.</p>}
        {AUTHOR_PLATFORMS.some((platform) => values.links[platform].url.trim()) ? <ul>
          {AUTHOR_PLATFORMS.filter((platform) => values.links[platform].url.trim()).map((platform) => {
            const link = normalizeSocialLink(platform, values.links[platform]);
            return <li key={platform}>
              {link.ok && link.value ? <a href={link.value.url} target="_blank" rel="noreferrer">{PLATFORM_LABELS[platform]} <span className="sr-only">(opens in a new tab)</span></a> : <span>{PLATFORM_LABELS[platform]}: {values.links[platform].url}</span>}
            </li>;
          })}
        </ul> : null}
      </div>
    </section>
  );
}
