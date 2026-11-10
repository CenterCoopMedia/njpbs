import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { hasCapability } from "../../../packages/content-core/src/rbac";
import { useAuth } from "../context/AuthContext";
import { AuthorProfileFields, AuthorProfilePreview } from "../components/AuthorProfileFields";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { AuthorPageControls } from "../components/AuthorPageControls";
import { useAuthorPagePosts } from "../lib/author-page-posts";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
} from "../components/ui/Primitives";
import {
  authorProfileFormChanged,
  authorProfileFormFromProfile,
  emptyAuthorProfileForm,
  validateAuthorProfileForm,
  type AuthorProfileFieldName,
  type AuthorProfileFormValues,
  type AuthorPhotoFormValue,
} from "../lib/author-profile-form";
import {
  AUTHOR_PHOTO_CATEGORY,
  uploadAuthorPhoto,
} from "../lib/author-photo";
import type { AuthorPhotoRightsBasis } from "../../../packages/content-core/src/author-profiles";
import {
  AUTHOR_PAGES_LIVE,
  AUTHOR_PROFILE_RELEASE_COPY,
} from "../lib/author-profile-release";
import { useOwnAuthorPhoto } from "./OwnAuthorPhotoContext";
import {
  cmsGetAuthorProfile,
  cmsListMedia,
  cmsSetAuthorProfileVisibility,
  cmsUpdateAuthorProfile,
  isConflictError,
  isInactiveAccountError,
  type AuthorPhoto,
  type SelfAuthorProfile,
} from "../lib/functions";

// The staff member's own author profile: what readers see beside their work, and the
// decision to make it public at all.
//
// Two rules shape this surface. Editors and above can publish their own profile
// here rather than in a queue, and the copy has to say plainly what
// publishing exposes. And the server is the authority: the form checks what it can before
// spending a request, but a refusal from the function is the answer that is shown.

// "inactive" is its own state, not a flavour of "error". A deactivated account is refused
// by every self endpoint, reads included, so there is no profile to show and nothing to
// retry: the honest surface is a plain explanation, not a form the server will not accept.
type LoadState = "loading" | "ready" | "error" | "inactive";

type Visibility = "published" | "private";

export { AUTHOR_PAGES_LIVE } from "../lib/author-profile-release";

/**
 * Which operation hit a 409, because the two need different ways out. A content
 * conflict can offer "save my version over theirs". A publish or unpublish
 * conflict cannot: the edit-overwrite path sends a text update and would never
 * make the visibility change the author actually asked for.
 */
type ConflictState =
  | { kind: "edit" }
  | { kind: "visibility"; visibility: Visibility }
  | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sameStoredPhoto(left: AuthorPhoto | null, right: AuthorPhoto | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.assetId === right.assetId &&
    left.url === right.url &&
    left.mimeType === right.mimeType &&
    left.width === right.width &&
    left.height === right.height &&
    left.sizeBytes === right.sizeBytes &&
    left.focalX === right.focalX &&
    left.focalY === right.focalY &&
    left.credit === right.credit &&
    left.rightsBasis === right.rightsBasis &&
    left.attestedAt === right.attestedAt
  );
}

export function AuthorProfileRoute() {
  const { state } = useAuth();
  if (
    state?.status === "signed-in" &&
    hasCapability(state.principal, "content.view") &&
    !hasCapability(state.principal, "content.create")
  ) {
    return (
      <Panel>
        <h1>My profile</h1>
        <p>{state.user.displayName || "No display name"}</p>
        <p>{state.user.email}</p>
        <InlineMessage tone="info" title="Profile is view only">
          An Owner can give you Contributor access to create and change an author profile.
        </InlineMessage>
      </Panel>
    );
  }
  return <EditableAuthorProfileRoute />;
}

function EditableAuthorProfileRoute() {
  const { getIdToken, state } = useAuth();
  const canPublish = state?.status === "signed-in" &&
    hasCapability(state.principal, "content.edit.any");
  const { setPhoto: setOwnPhoto } = useOwnAuthorPhoto();
  // Load, save, publish and unpublish all cross an await, and this route can unmount mid
  // request -- a fast navigation away, or a test that renders and tears down before the
  // request settles. Without this, the response arrives, finds an unmounted component, and
  // React logs a state-update warning that fires after the test's own environment has begun
  // tearing down, matching the shell's own-photo fetch just above it in the mount chain and
  // AuthContext's generation guard.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SelfAuthorProfile | null>(null);
  const [values, setValues] = useState<AuthorProfileFormValues>(
    emptyAuthorProfileForm(),
  );
  const [baseline, setBaseline] = useState<AuthorProfileFormValues>(
    emptyAuthorProfileForm(),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<AuthorProfileFieldName, string>>
  >({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState>(null);
  const [visibilityPending, setVisibilityPending] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [visibilityNotice, setVisibilityNotice] = useState<string | null>(null);
  const authorPagePosts = useAuthorPagePosts(
    profile?.authorId ?? null,
    loadState === "ready",
  );

  // Every load, save, publish and withdrawal on this screen ends here, so it is
  // the one place that has to tell the shell about the photograph. Without it the
  // sidebar and header avatars kept showing initials until the next full reload.
  const applyProfile = useCallback(
    (next: SelfAuthorProfile) => {
      const filled = authorProfileFormFromProfile(next);
      setProfile(next);
      setValues(filled);
      setBaseline(filled);
      setConflict(null);
      setOwnPhoto(next.photo ?? null);
    },
    [setOwnPhoto],
  );

  const load = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const token = await getIdToken();
      const response = await cmsGetAuthorProfile(token);
      if (!mountedRef.current) return;
      applyProfile(response.profile);
      setLoadState("ready");
    } catch (error) {
      if (!mountedRef.current) return;
      if (isInactiveAccountError(error)) {
        setLoadState("inactive");
        return;
      }
      setLoadError(
        errorMessage(error, "Your profile could not be opened. Try again."),
      );
      setLoadState("error");
    }
  }, [applyProfile, getIdToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = authorProfileFormChanged(values, baseline);

  function updateValues(next: AuthorProfileFormValues) {
    setValues(next);
    setSavedMessage(null);
    setSaveError(null);
  }

  // `overwrite` is the deliberate second half of the conflict state: read the stored
  // version first, then save against it. It is offered only after the author has been
  // told someone else changed the profile, so overwriting is a choice, never a retry
  // that quietly wins a race.
  async function submit(overwrite = false): Promise<void> {
    if (!profile) return;
    const validation = validateAuthorProfileForm(values);
    setFieldErrors(validation.fieldErrors);
    setFormErrors(validation.formErrors);
    if (!validation.ok || !validation.value) {
      setSavedMessage(null);
      setSaveError(null);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    try {
      const token = await getIdToken();
      const expectedVersion = overwrite
        ? (await cmsGetAuthorProfile(token)).profile.version
        : profile.version;
      const response = await cmsUpdateAuthorProfile(token, {
        ...validation.value,
        expectedVersion,
      });
      if (!mountedRef.current) return;
      applyProfile(response.profile);
      setSavedMessage("Profile saved.");
    } catch (error) {
      if (!mountedRef.current) return;
      // An account can be deactivated between opening this form and saving it.
      // Falling through to a generic error would leave an editable form the server
      // will never accept, so the whole surface becomes the inactive state.
      if (isInactiveAccountError(error)) {
        setLoadState("inactive");
      } else if (isConflictError(error)) {
        setConflict({ kind: "edit" });
      } else {
        setSaveError(
          errorMessage(error, "Your profile could not be saved. Try again."),
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  // The photograph goes through the ordinary media boundary: this is the same
  // upload every other asset takes, with the category and the rights attestation
  // fixed. The server confines the scoped path to profile photographs, so nothing
  // here is what keeps a contributor out of the rest of the library.
  const uploadPhoto = useCallback(
    async (
      file: File,
      options: { rightsBasis: AuthorPhotoRightsBasis; credit: string },
    ) => {
      const token = await getIdToken();
      const response = await uploadAuthorPhoto(token, file, {
        displayName: values.displayName || profile?.displayName || "",
        rightsBasis: options.rightsBasis,
        credit: options.credit,
      });
      return response.asset;
    },
    [getIdToken, profile, values.displayName],
  );

  const loadPhotoMedia = useCallback(
    async (query: Parameters<typeof cmsListMedia>[1]) => {
      const token = await getIdToken();
      return cmsListMedia(token, {
        ...query,
        categories: [AUTHOR_PHOTO_CATEGORY],
        kinds: ["image"],
        profilePhotoScope: "self",
      });
    },
    [getIdToken],
  );

  // A profile photograph is one user action even though a new file crosses two
  // storage boundaries. A new file enters the media library first; an existing
  // file is reused there. This callback then binds either asset id to the profile.
  // Before this completion step, a person could save while an upload was still in
  // progress; the upload then finished as an unused library asset and the profile
  // kept its old photograph.
  //
  // Read the current saved profile before attaching the file. This preserves any
  // profile save that completed while the upload was in flight. Local edits made
  // during the upload stay in `values`; only the saved photo and version baseline
  // are replaced below.
  const saveUploadedPhoto = useCallback(
    async (photo: AuthorPhotoFormValue): Promise<void> => {
      setSaving(true);
      setSaveError(null);
      setSavedMessage(null);
      try {
        const token = await getIdToken();
        let current = (await cmsGetAuthorProfile(token)).profile;
        const photoBeforeAttachment = current.photo;
        let response: Awaited<ReturnType<typeof cmsUpdateAuthorProfile>> | null = null;

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const currentValues = authorProfileFormFromProfile(current);
          const validation = validateAuthorProfileForm({
            ...currentValues,
            photo,
          });
          if (!validation.ok || !validation.value) {
            throw new Error(
              validation.fieldErrors.photo ??
                validation.formErrors[0] ??
                "The uploaded photo could not be attached to your profile.",
            );
          }
          try {
            response = await cmsUpdateAuthorProfile(token, {
              ...validation.value,
              expectedVersion: current.version,
            });
            break;
          } catch (error) {
            if (!isConflictError(error) || attempt === 1) throw error;
            const refreshed = (await cmsGetAuthorProfile(token)).profile;
            if (!sameStoredPhoto(refreshed.photo, photoBeforeAttachment)) {
              throw new Error(
                "Someone else changed this profile photo while your upload was in progress. Reload the profile before you try again.",
              );
            }
            current = refreshed;
          }
        }

        if (!response || !mountedRef.current) return;
        const savedValues = authorProfileFormFromProfile(response.profile);
        setProfile(response.profile);
        setBaseline(savedValues);
        setValues((localValues) => ({
          ...localValues,
          photo: savedValues.photo,
        }));
        setConflict(null);
        setOwnPhoto(response.profile.photo ?? null);
        setSavedMessage("Photo saved.");
      } catch (error) {
        if (!mountedRef.current) return;
        if (isInactiveAccountError(error)) {
          setLoadState("inactive");
          return;
        }
        throw new Error(
          `The photo was chosen, but your profile could not be updated. ${errorMessage(
            error,
            "Try the upload again.",
          )}`,
        );
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [getIdToken, setOwnPhoto],
  );

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  // `retry` is the way out of a publish/unpublish conflict: read the stored version,
  // then make the same visibility change against it. It is only ever offered with a
  // clean form, so nothing typed can be lost to the reload it does.
  async function setVisibility(
    visibility: Visibility,
    retry = false,
  ): Promise<void> {
    if (!profile) return;
    setVisibilityPending(true);
    setVisibilityError(null);
    setVisibilityNotice(null);
    try {
      const token = await getIdToken();
      const expectedVersion = retry
        ? (await cmsGetAuthorProfile(token)).profile.version
        : profile.version;
      const response = await cmsSetAuthorProfileVisibility(token, {
        visibility,
        expectedVersion,
      });
      if (!mountedRef.current) return;
      applyProfile(response.profile);
      setVisibilityNotice(
        visibility === "published"
          ? "Your profile is published."
          : "Your profile is no longer published.",
      );
    } catch (error) {
      if (!mountedRef.current) return;
      if (isInactiveAccountError(error)) {
        setLoadState("inactive");
      } else if (isConflictError(error)) {
        setConflict({ kind: "visibility", visibility });
      } else {
        setVisibilityError(
          errorMessage(
            error,
            "That change could not be made. Try again.",
          ),
        );
      }
    } finally {
      if (mountedRef.current) setVisibilityPending(false);
    }
  }

  if (loadState === "loading") {
    return (
      <div className="route-loading">
        <LoadingIndicator
          label="Opening your profile"
          layout="stack"
          stages={[
            "Getting a fresh sign-in token",
            "Asking the CMS for your author profile",
            "Loading your byline, biography and photo",
          ]}
        />
      </div>
    );
  }

  if (loadState === "inactive") {
    return (
      <div className="author-profile">
        <Panel aria-labelledby="author-profile-inactive-heading">
          <div className="panel-heading">
            <div>
              <h2 id="author-profile-inactive-heading">
                Your CMS account is deactivated
              </h2>
              <p>
                Your profile is no longer marked published in the CMS, and it cannot
                be opened or edited while the account is closed. Your published work
                stays online. Ask an administrator to reactivate your account if you
                think this is a mistake.
              </p>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  if (loadState === "error" || !profile) {
    return (
      <div className="author-profile">
        <InlineMessage tone="error" title="Profile unavailable">
          {loadError ?? "Your profile could not be opened. Try again."}
        </InlineMessage>
        <Button onClick={() => void load()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  }

  // No deactivated branch below this point: the server refuses every self endpoint for a
  // closed account, so a profile that loaded belongs to an active one.
  const published = profile.visibility === "published";

  return (
    <div className="author-profile author-profile-workspace">
      <form
        aria-labelledby="author-profile-heading"
        className="panel author-profile-form author-profile-editor-panel"
        onSubmit={onSubmit}
      >
        <h2 className="sr-only" id="author-profile-heading">
          Your public profile
        </h2>

        {conflict?.kind === "edit" ? (
          <InlineMessage tone="warning" title="Someone else changed this profile">
            Your copy is out of date, so it was not saved. Load the saved version
            to see the current text, or keep your version and save over it.
            <div className="author-profile-conflict-actions">
              <Button onClick={() => void load()} variant="secondary">
                Load the saved version
              </Button>
              <Button onClick={() => void submit(true)} variant="secondary">
                Save my version anyway
              </Button>
            </div>
          </InlineMessage>
        ) : null}

        <AuthorProfileFields
          disabled={saving}
          errors={fieldErrors}
          idPrefix="self-profile"
          loadPhotoMedia={loadPhotoMedia}
          onChange={updateValues}
          onPhotoUpload={uploadPhoto}
          onPhotoUploaded={saveUploadedPhoto}
          photoProfileIsPublished={profile.visibility === "published"}
          photoSubject="self"
          values={values}
        />

        <AuthorPageControls
          disabled={saving}
          hasMore={authorPagePosts.hasMore}
          idPrefix="self-profile"
          loadingMore={authorPagePosts.loadingMore}
          moreError={authorPagePosts.moreError}
          onChange={(next) => updateValues({ ...values, ...next })}
          onLoadMore={() => void authorPagePosts.loadMore()}
          onReload={authorPagePosts.reload}
          posts={authorPagePosts.posts}
          postsState={authorPagePosts.state}
          subject="self"
          value={{
            pinnedPostId: values.pinnedPostId,
            hiddenPostIds: values.hiddenPostIds,
          }}
        />

        <div className="author-profile-feedback">
          {formErrors.length > 0 ? (
            <InlineMessage tone="error" title="Check this profile">
              <ul>
                {formErrors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </InlineMessage>
          ) : null}
          {saveError ? <InlineMessage tone="error">{saveError}</InlineMessage> : null}
          {savedMessage ? (
            <InlineMessage tone="success">{savedMessage}</InlineMessage>
          ) : null}
        </div>

        <div className="author-profile-savebar">
          <span className="author-profile-save-state" role="status">
            {dirty ? "Unsaved changes" : "No unsaved changes"}
          </span>
          <div className="author-profile-actions">
            <AsyncActionButton
              disabled={!dirty}
              label="Save profile"
              pending={saving}
              pendingAnnouncement="Saving your profile."
              pendingLabel="Saving…"
              type="submit"
              variant="primary"
            />
          </div>
        </div>
      </form>

      <div className="author-profile-sidebar">
        <Panel className="author-profile-preview-panel">
          <AuthorProfilePreview values={values} />
        </Panel>
        <Panel
          aria-labelledby="author-visibility-heading"
          className="author-profile-publishing-panel"
        >
          <div className="panel-heading">
            <div>
              <h2 id="author-visibility-heading">Publishing</h2>
              <p>{AUTHOR_PROFILE_RELEASE_COPY.publishingDescription}</p>
            </div>
          </div>

          <p className="field-hint">
            {AUTHOR_PROFILE_RELEASE_COPY.selfProfileDescription(published)}
          </p>

          <p className="author-profile-status" role="status">
            {published
              ? AUTHOR_PROFILE_RELEASE_COPY.publishedStatus(profile.publicPath)
              : "Your profile is not published. Only staff signed in to the CMS can see it."}
          </p>

          {published && profile.publicPath ? (
            <p className="field-hint">
              {AUTHOR_PROFILE_RELEASE_COPY.addressHint}
            </p>
          ) : null}

          {/*
            Both buttons act on the saved profile and then replace the form with what
            came back, so running either with unsaved edits on screen would throw those
            edits away without saying so. Save or discard first.
          */}
          {dirty ? (
            <InlineMessage tone="warning">
              Save your changes first. Publishing and unpublishing both act on the
              saved version of your profile, and doing either now would discard
              what you have just typed.
            </InlineMessage>
          ) : null}

          {!AUTHOR_PAGES_LIVE ? (
            <InlineMessage tone="info" title="Publishing is paused">
              You can save your profile while self-service publication is paused. Published
              profiles can still be updated or unpublished; confirm changes on
              their public pages.
            </InlineMessage>
          ) : null}

          {!canPublish ? (
            <InlineMessage tone="info" title="Profile publishing access">
              You can save your profile and unpublish it. Publishing your own
              profile requires Editor access or higher. Ask an admin to publish
              it from Staff profiles.
            </InlineMessage>
          ) : null}

          {conflict?.kind === "visibility" ? (
            <InlineMessage tone="warning" title="Someone else changed this profile">
              {conflict.visibility === "published"
                ? "Your copy is out of date, so your profile was not published."
                : "Your copy is out of date, so your profile was not unpublished."}{" "}
              Load the saved version to see where it stands, or try the same change
              again against the saved version.
              <div className="author-profile-conflict-actions">
                <Button onClick={() => void load()} variant="secondary">
                  Load the saved version
                </Button>
                <Button
                  disabled={conflict.visibility === "published" && (!canPublish || !AUTHOR_PAGES_LIVE)}
                  onClick={() => void setVisibility(conflict.visibility, true)}
                  variant="secondary"
                >
                  {conflict.visibility === "published"
                    ? "Try publishing again"
                    : "Try unpublishing again"}
                </Button>
              </div>
            </InlineMessage>
          ) : null}

          {visibilityError ? (
            <InlineMessage tone="error">{visibilityError}</InlineMessage>
          ) : null}
          {visibilityNotice ? (
            <InlineMessage tone="success">{visibilityNotice}</InlineMessage>
          ) : null}

          <div className="author-profile-actions">
            {published ? (
              <AsyncActionButton
                disabled={dirty}
                label="Unpublish profile"
                pending={visibilityPending}
                pendingAnnouncement="Unpublishing your profile."
                pendingLabel="Unpublishing…"
                onClick={() => void setVisibility("private")}
                variant="secondary"
              />
            ) : (
              <AsyncActionButton
                disabled={dirty || !AUTHOR_PAGES_LIVE || !canPublish}
                label="Publish profile"
                pending={visibilityPending}
                pendingAnnouncement="Publishing your profile."
                pendingLabel="Publishing…"
                onClick={() => void setVisibility("published")}
                variant="primary"
              />
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
