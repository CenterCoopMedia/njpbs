import { InfoTooltip } from "../components/ui/InfoTooltip";
import { type FormEvent, useCallback, useEffect, useRef, useState, } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "../context/AuthContext";
import { AuthorProfileFields, AuthorProfilePreview } from "../components/AuthorProfileFields";
import { AuthorPageControls } from "../components/AuthorPageControls";
import { useAuthorPagePosts } from "../lib/author-page-posts";
import { AuthorAvatar } from "../components/ui/AuthorAvatar";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import {
  AsyncActionButton,
  Button,
  EmptyState,
  InlineMessage,
  Panel,
  Select,
  StatusBadge,
  TableFrame,
  TextInput,
} from "../components/ui/Primitives";
import { canManageAuthorProfiles, canUseMediaLibrary } from "../lib/access";
import {
  AUTHOR_PHOTO_CATEGORY,
  uploadAuthorPhoto
} from "../lib/author-photo";
import type { AuthorPhotoRightsBasis } from "../../../packages/content-core/src/author-profiles";
import {
  authorProfileFormChanged,
  authorProfileFormFromProfile,
  emptyAuthorProfileForm,
  validateAuthorProfileForm,
  type AuthorProfileFieldName,
  type AuthorProfileFormValues,
} from "../lib/author-profile-form";
import { AUTHOR_PROFILE_RELEASE_COPY } from "../lib/author-profile-release";
import {
  cmsAdminUpdateAuthorProfile,
  cmsCreateAuthorProfile,
  cmsListMedia,
  cmsListAuthorProfiles,
  isConflictError,
  type AdminAuthorProfile,
  type LinkableAuthorUser,
} from "../lib/functions";
import { RequireCapability } from "./RequireCapability";
import { useShell } from "./ShellContext";

// The admin surface for author profiles: read the roster, correct a byline, or take a
// public profile down.
//
// Two boundaries are stated in the copy because they are real and staff cannot see the
// code: editing a profile never changes anyone's role or access, and every change here is
// recorded in the activity log against the admin who made it. Withdrawal asks for a second
// confirmation, since it removes a page readers may already have linked to.

type LoadState = "loading" | "ready" | "error";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isVersionConflict(error: unknown): boolean {
  if (!isConflictError(error) || typeof error !== "object" || error === null) {
    return false;
  }
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === "version_conflict"
  );
}

function AuthorProfilesSurface() {
  const { getIdToken } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedAuthorId = searchParams.get("authorId") ?? undefined;
  const { principal } = useShell();
  const generalMediaAccess = canUseMediaLibrary(principal);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AdminAuthorProfile[]>([]);
  const [linkableUsers, setLinkableUsers] = useState<LinkableAuthorUser[]>([]);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminAuthorProfile | null>(null);
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [confirmingLink, setConfirmingLink] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [linkedUid, setLinkedUid] = useState("");
  const [lifecycleAction, setLifecycleAction] = useState<
    "publish" | "link" | "archive" | "delete" | null
  >(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const authorPagePosts = useAuthorPagePosts(
    selected?.authorId ?? null,
    selected !== null,
  );
  // The listing is paged server-side. Holding the cursor is what makes the rest of
  // the roster reachable: without it the screen silently stops at the first page and
  // an author on page two cannot be corrected or taken down at all.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const open = useCallback((profile: AdminAuthorProfile): void => {
    const filled = authorProfileFormFromProfile(profile);
    setSelected(profile);
    setValues(filled);
    setBaseline(filled);
    setFieldErrors({});
    setFormErrors([]);
    setActionError(null);
    setNotice(null);
    setConflict(false);
    setConfirmingWithdraw(false);
    setConfirmingLink(false);
    setConfirmingArchive(false);
    setConfirmingDelete(false);
    setLinkedUid("");
  }, []);

  function closeProfile() {
    setSelected(null);
    if (linkedAuthorId) setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.delete("authorId");
      return next;
    });
  }

  const load = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    setMoreError(null);
    try {
      const token = await getIdToken();
      const response = linkedAuthorId ? await cmsListAuthorProfiles(token, { authorId: linkedAuthorId })
        : await cmsListAuthorProfiles(token);
      if (linkedAuthorId) {
        const profile = response.profiles.find(entry => entry.authorId === linkedAuthorId);
        if (!profile) throw new Error("That author profile could not be found.");
        open(profile);
      }
      setProfiles(response.profiles);
      setLinkableUsers(response.linkableUsers ?? []);
      setNextCursor(response.nextCursor);
      setLoadState("ready");
    } catch (error) {
      setLoadError(
        errorMessage(error, "Staff profiles could not be opened. Try again."),
      );
      setLoadState("error");
    }
  }, [getIdToken, linkedAuthorId, open]);

  // Appends the next page. A failure here leaves the rows already on screen alone and
  // says so beside the button, rather than emptying the roster.
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const token = await getIdToken();
      const response = await cmsListAuthorProfiles(token, { startAfter: nextCursor, });
      setProfiles((current) => [...current, ...response.profiles]);
      setLinkableUsers(response.linkableUsers ?? []);
      setNextCursor(response.nextCursor);
    } catch (error) {
      setMoreError(
        errorMessage(error, "More staff profiles could not be loaded. Try again.",),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [getIdToken, nextCursor]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyUpdated(profile: AdminAuthorProfile): void {
    setProfiles((current) =>
      current.map((entry) =>entry.authorId === profile.authorId ? profile : entry,),
    );
    const filled = authorProfileFormFromProfile(profile);
    setSelected(profile);
    setValues(filled);
    setBaseline(filled);
    setConflict(false);
  }

  const dirty = selected ? authorProfileFormChanged(values, baseline) : false;
  const linkedUser = linkableUsers.find((entry) => entry.uid === linkedUid);

  async function createProfile(
    event: FormEvent<HTMLFormElement>,): Promise<void> {
    event.preventDefault();

  const displayName = createName.trim();
    if (!displayName) {
      setCreateError("Enter the staff member's public name.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const token = await getIdToken();
      const response = await cmsCreateAuthorProfile(token, { displayName });
      // The roster is ordered and paged by authorId. A freshly minted random id
      // cannot be prepended while retaining the old cursor without risking a
      // duplicate on the next page, so replace the first page and its cursor.
      await load();
      setCreateName("");
      open(response.profile);
      setNotice(
        "Staff profile created. It is not linked to a CMS account yet.",
      );
    } catch (error) {
      setCreateError(
        errorMessage(error, "That staff profile could not be created."),
      );
    } finally {
      setCreating(false);
    }
  }

  async function runLifecycleAction(
    action: "publish" | "link" | "archive",
  ): Promise<void> {
    if (!selected) return;
    setLifecycleAction(action);
    setActionError(null);
    setNotice(null);
    try {
      const token = await getIdToken();
      const response =
        action === "link"
          ? await cmsAdminUpdateAuthorProfile(token, {
              action: "link",
              authorId: selected.authorId,
              uid: linkedUid,
              expectedVersion: selected.version,
            })
          : action === "publish"
            ? await cmsAdminUpdateAuthorProfile(token, {
                action: "publish",
                authorId: selected.authorId,
                expectedVersion: selected.version,
              })
            : await cmsAdminUpdateAuthorProfile(token, {
                action: "archive",
                authorId: selected.authorId,
                expectedVersion: selected.version,
              });
      applyUpdated(response.profile);
      if (action === "link") {
        setLinkableUsers((current) =>
          current.filter((entry) => entry.uid !== linkedUid),
        );
        setConfirmingLink(false);
        setNotice(
          "CMS account linked. The author id, bylines, slug history and public address did not change.",
        );
      } else if (action === "publish") {
        setNotice(
          "Profile published in the CMS with its stable public address.",
        );
      } else {
        setConfirmingArchive(false);
        setNotice(
          "Profile archived. Its identity, bylines and reserved slugs were preserved.",
        );
      }
    } catch (error) {
      if (isVersionConflict(error)) setConflict(true);
      else
        setActionError(
          errorMessage(error, "That profile action could not be completed."),
        );
    } finally {
      setLifecycleAction(null);
    }
  }

  async function deleteDraft(): Promise<void> {
    if (!selected) return;
    setLifecycleAction("delete");
    setActionError(null);
    try {
      const token = await getIdToken();
      await cmsAdminUpdateAuthorProfile(token, {
        action: "delete",
        authorId: selected.authorId,
        expectedVersion: selected.version,
      });
      setProfiles((current) =>
        current.filter((entry) => entry.authorId !== selected.authorId),
      );
      closeProfile();
    } catch (error) {
      if (isVersionConflict(error)) setConflict(true);
      else
        setActionError(errorMessage(error, "That draft could not be deleted."));
    } finally {
      setLifecycleAction(null);
      setConfirmingDelete(false);
    }
  }

  // An admin may upload a photograph on someone else's behalf. It lands in the
  // same profile category, and the admin callable is what permits binding it to a
  // profile that is not the uploader's own.
  //
  // An upload outlives the editor it was started in. One admin screen serves the
  // whole roster, so switching profiles while a file is in flight used to land
  // the first person's photograph in the second person's form -- their face,
  // their rights basis, their credit line, one Save away from the wrong public
  // page. Two things stop it: the fields are keyed by authorId below, so the
  // staged file and attestation are discarded with the editor they belong to, and
  // the completion is checked against the profile that is open now. `selectedRef`
  // holds the current selection because the in-flight callback closed over the
  // selection it started with.
  const selectedRef = useRef<AdminAuthorProfile | null>(null);
  selectedRef.current = selected;

  const uploadPhoto = useCallback(
    async (
      file: File,
      options: { rightsBasis: AuthorPhotoRightsBasis; credit: string },
    ) => {
      const startedFor = selectedRef.current;
      if (!startedFor) {
        throw new Error("Open a staff profile before uploading a photo.");
      }
      const token = await getIdToken();
      const response = await uploadAuthorPhoto(token, file, {
        displayName: values.displayName || startedFor.displayName || "",
        rightsBasis: options.rightsBasis,
        credit: options.credit,
      });
      if (selectedRef.current?.authorId !== startedFor.authorId) {
        // The photo is in the media library and can be attached again from the
        // right editor. What must not happen is writing it into whoever is open
        // now, so the completion is dropped rather than applied.
        throw new Error(
          `That upload finished after you opened another profile, so it was not added to ${startedFor.displayName}. Open their profile and upload it again.`,
        );
      }
      return response.asset;
    },
    [getIdToken, values.displayName],
  );

  const loadPhotoMedia = useCallback(
    async (query: Parameters<typeof cmsListMedia>[1]) => {
      const token = await getIdToken();
      return cmsListMedia(token, {
        ...query,
        kinds: ["image"],
        ...(!generalMediaAccess ? {
          categories: [AUTHOR_PHOTO_CATEGORY],
          profilePhotoScope: "self" as const,
        } : {}),
      });
    },
    [getIdToken, generalMediaAccess],
  );

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) return;
    const validation = validateAuthorProfileForm(values);
    setFieldErrors(validation.fieldErrors);
    setFormErrors(validation.formErrors);
    if (!validation.ok || !validation.value) return;

    setSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      const token = await getIdToken();
      const response = await cmsAdminUpdateAuthorProfile(token, {
        action: "edit",
        authorId: selected.authorId,
        ...validation.value,
        expectedVersion: selected.version,
      });
      applyUpdated(response.profile);
      setNotice("Profile saved. The change is recorded in the activity log.");
    } catch (error) {
      if (isConflictError(error)) {
        setConflict(true);
      } else {
        setActionError(
          errorMessage(error, "That profile could not be saved. Try again."),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function withdraw(): Promise<void> {
    if (!selected) return;
    setWithdrawing(true);
    setActionError(null);
    setNotice(null);
    try {
      const token = await getIdToken();
      const response = await cmsAdminUpdateAuthorProfile(token, {
        action: "withdraw",
        authorId: selected.authorId,
        expectedVersion: selected.version,
      });
      applyUpdated(response.profile);
      setConfirmingWithdraw(false);
      setNotice(
        "The published profile was withdrawn in the CMS. The author's role and access are unchanged.",
      );
    } catch (error) {
      if (isConflictError(error)) {
        setConflict(true);
      } else {
        setActionError(
          errorMessage(
            error,
            "That profile could not be withdrawn. Try again.",
          ),
        );
      }
    } finally {
      setWithdrawing(false);
    }
  }

  if (loadState === "loading") {
    return (
      <div className="route-loading">
        <LoadingIndicator
          label="Opening staff profiles"
          layout="stack"
          stages={[
            "Getting a fresh sign-in token",
            "Asking the CMS for the first page of staff profiles",
            "Matching profiles to linkable staff accounts",
          ]}
        />
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="author-profiles">
        <InlineMessage tone="error" title="Staff profiles unavailable">
          {loadError}
        </InlineMessage>
        <Button onClick={() => void load()} variant="secondary">
          Try again
        </Button>
        {linkedAuthorId ? <Button onClick={closeProfile}>Browse staff profiles</Button> : null}
      </div>
    );
  }

  return (
    <div className="author-profiles">
      {!linkedAuthorId ? <Panel aria-labelledby="author-profiles-heading">
        <div className="panel-heading">
          <div>
            <h2 id="author-profiles-heading">Staff profiles</h2>
            <p>{AUTHOR_PROFILE_RELEASE_COPY.adminOverview}</p>
          </div>
        </div>

        <form className="author-profile-create" onSubmit={createProfile}>
          <div className="author-profile-field">
            <div className="editor-field-label-row"><label htmlFor="new-author-profile-name">
              New staff profile name
            </label><InfoTooltip label="New staff profile name" content="Create the public identity now. You can link an approved CMS account later." /></div>
            <TextInput
              id="new-author-profile-name"
              maxLength={120}
              onChange={(event) => {
                setCreateName(event.target.value);
                setCreateError(null);
              }}
              value={createName}
            />

          </div>
          <AsyncActionButton
            label="Create staff profile"
            pending={creating}
            pendingAnnouncement="Creating the staff profile."
            pendingLabel="Creating…"
            type="submit"
            variant="primary"
          />
        </form>
        {createError ? (
          <InlineMessage tone="error">{createError}</InlineMessage>
        ) : null}

        {profiles.length === 0 ? (
          <EmptyState
            description="Create a public staff identity here, or link one after the staff member receives CMS access."
            title="No staff profiles yet"
          />
        ) : (
          <TableFrame>
            <table className="data-table author-profiles-table">
              <caption className="sr-only">Staff author profiles</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Job title</th>
                  <th scope="col">
                    {AUTHOR_PROFILE_RELEASE_COPY.adminStateColumn}
                  </th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((entry) => (
                  <tr key={entry.authorId}>
                    <th data-label="Name" scope="row">
                      <span className="author-profiles-name">
                        <AuthorAvatar
                          displayName={entry.displayName}
                          photo={entry.photo}
                        />
                        {entry.displayName}
                      </span>
                    </th>
                    <td data-label="Job title">
                      {entry.jobTitle ?? "Not set"}
                    </td>
                    <td
                      data-label={AUTHOR_PROFILE_RELEASE_COPY.adminStateColumn}
                    >
                      <StatusBadge
                        tone={
                          entry.lifecycle === "archived"
                            ? "neutral"
                            : entry.visibility === "published"
                              ? "success"
                              : "neutral"
                        }
                      >
                        {entry.lifecycle === "archived"
                          ? "Archived"
                          : entry.visibility === "published"
                            ? AUTHOR_PROFILE_RELEASE_COPY.adminPublishedBadge
                            : "Not published"}
                      </StatusBadge>
                    </td>
                    <td data-label="Actions">
                      <Button onClick={() => open(entry)} variant="secondary">
                        {`Open profile for ${entry.displayName}`}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}

        {moreError ? (
          <InlineMessage tone="error">{moreError}</InlineMessage>
        ) : null}

        {nextCursor ? (
          <div className="author-profile-actions">
            <AsyncActionButton
              label="Load more staff profiles"
              pending={loadingMore}
              pendingAnnouncement="Loading more staff profiles."
              pendingLabel="Loading…"
              onClick={() => void loadMore()}
              variant="secondary"
            />
          </div>
        ) : null}
      </Panel> : null}

      {selected ? (
        <section
          aria-labelledby="author-profile-editor-heading"
          className="author-profile-editor"
        >
          <div className="author-profile-editor-heading">
            <h2 id="author-profile-editor-heading">
              {`Editing the profile for ${selected.displayName}`}
            </h2>
            <p>
              You are editing someone else's profile. The change is recorded
              against your account in the activity log, and it does not change
              their role, their section access, or anything they have published.
            </p>
          </div>

          {conflict ? (
            <InlineMessage
              tone="warning"
              title="Someone else changed this profile"
            >
              Your copy is out of date, so nothing was saved. Reload the list
              and open the profile again to see the current text.
              <div className="author-profile-conflict-actions">
                <Button onClick={() => void load()} variant="secondary">
                  Reload staff profiles
                </Button>
              </div>
            </InlineMessage>
          ) : null}

          <div className="author-profile-workspace">
            <form
              className="panel author-profile-form author-profile-editor-panel"
              onSubmit={save}
            >
            <AuthorProfileFields
              key={selected.authorId}
              disabled={saving || selected.lifecycle === "archived"}
              errors={fieldErrors}
              idPrefix={`admin-profile-${selected.authorId}`}
              loadPhotoMedia={loadPhotoMedia}
              onChange={(next) => {
                setValues(next);
                setNotice(null);
                setActionError(null);
              }}
              onPhotoUpload={uploadPhoto}
              photoProfileIsPublished={selected.visibility === "published"}
              photoSubject="other"
              photoSubjectName={selected.displayName}
              values={values}
            />

            <AuthorPageControls
              disabled={saving}
              hasMore={authorPagePosts.hasMore}
              idPrefix={`admin-profile-${selected.authorId}`}
              loadingMore={authorPagePosts.loadingMore}
              moreError={authorPagePosts.moreError}
              onChange={(next) => {
                setValues({ ...values, ...next });
                setNotice(null);
                setActionError(null);
              }}
              onLoadMore={() => void authorPagePosts.loadMore()}
              onReload={authorPagePosts.reload}
              posts={authorPagePosts.posts}
              postsState={authorPagePosts.state}
              subject="other"
              subjectName={selected.displayName}
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
              {actionError ? (
                <InlineMessage tone="error">{actionError}</InlineMessage>
              ) : null}
              {notice ? (
                <InlineMessage tone="success">{notice}</InlineMessage>
              ) : null}
            </div>

            <div className="author-profile-savebar">
              <span className="author-profile-save-state" role="status">
                {dirty ? "Unsaved changes" : "No unsaved changes"}
              </span>
              <div className="author-profile-actions">
                <Button onClick={closeProfile} variant="ghost">
                  Close this profile
                </Button>
                <AsyncActionButton
                  disabled={!dirty || selected.lifecycle === "archived"}
                  label="Save profile"
                  pending={saving}
                  pendingAnnouncement="Saving this profile."
                  pendingLabel="Saving…"
                  type="submit"
                  variant="primary"
                />
              </div>
            </div>
            </form>

            <aside
              aria-label="Profile preview and management"
              className="author-profile-sidebar"
            >
              <Panel className="author-profile-preview-panel">
                <AuthorProfilePreview values={values} />
              </Panel>
              <Panel className="author-profile-management-panel">
          {selected.lifecycle === "active" && selected.uid === null ? (
            <div className="author-profile-link">
              <h3>CMS account</h3>
              <p>
                Optional. Linking enables this staff member to edit their own
                profile without changing its identity or URLs.
              </p>
              {linkableUsers.length > 0 ? (
                <>
                  <label htmlFor={`link-author-${selected.authorId}`}>
                    Approved CMS user
                  </label>
                  <Select
                    id={`link-author-${selected.authorId}`}
                    onChange={(event) => {
                      setLinkedUid(event.target.value);
                      setConfirmingLink(false);
                    }}
                    value={linkedUid}
                  >
                    <option value="">Choose a user</option>
                    {linkableUsers.map((entry) => (
                      <option key={entry.uid} value={entry.uid}>
                        {`${entry.displayName} (${entry.email ?? entry.uid})`}
                      </option>
                    ))}
                  </Select>
                  {confirmingLink && linkedUser ? (
                    <div
                      aria-label="Confirm permanent CMS account link"
                      className="author-profile-confirm"
                      role="group"
                    >
                      <p>
                        {`Permanently link this profile to ${linkedUser.displayName} (${linkedUser.email ?? linkedUser.uid})? That account will be able to edit this public identity.`}
                      </p>
                      <AsyncActionButton
                        disabled={dirty}
                        label="Yes, link CMS account"
                        pending={lifecycleAction === "link"}
                        pendingAnnouncement="Linking the CMS account."
                        pendingLabel="Linking…"
                        onClick={() => void runLifecycleAction("link")}
                        variant="secondary"
                      />
                      <Button
                        onClick={() => setConfirmingLink(false)}
                        variant="ghost"
                      >
                        Do not link
                      </Button>
                    </div>
                  ) : (
                    <Button
                      disabled={!linkedUser || dirty}
                      onClick={() => setConfirmingLink(true)}
                      variant="secondary"
                    >
                      Link CMS account
                    </Button>
                  )}
                </>
              ) : (
                <p>No approved, unlinked CMS users are available.</p>
              )}
            </div>
          ) : null}

          {selected.lifecycle === "active" &&
          selected.visibility === "private" ? (
            <div className="author-profile-publish">
              <h3>Publishing</h3>
              <p>{AUTHOR_PROFILE_RELEASE_COPY.adminPublishingDescription}</p>
              <AsyncActionButton
                disabled={dirty}
                label="Publish profile in CMS"
                pending={lifecycleAction === "publish"}
                pendingAnnouncement="Publishing this profile."
                pendingLabel="Publishing…"
                onClick={() => void runLifecycleAction("publish")}
                variant="primary"
              />
            </div>
          ) : null}

          {selected.visibility === "published" ? (
            <div className="author-profile-withdraw">
              <h3>Published profile</h3>
              <p>
                {AUTHOR_PROFILE_RELEASE_COPY.adminPublishedDescription(
                  selected.publicPath,
                )}
              </p>
              {/*
                Withdrawing replaces the open form with what the server returns, so
                doing it with unsaved edits on screen would throw them away without
                saying so. Save or close the form first.
              */}
              {dirty ? (
                <InlineMessage tone="warning">
                  Save your changes first. Withdrawing acts on the saved profile
                  and would discard the edits you have just made.
                </InlineMessage>
              ) : null}
              {confirmingWithdraw ? (
                <div
                  aria-labelledby="withdraw-confirm-heading"
                  className="author-profile-confirm"
                  role="group"
                >
                  <p id="withdraw-confirm-heading">
                    {`Withdraw the published profile for ${selected.displayName}?`}
                  </p>
                  <div className="author-profile-actions">
                    <AsyncActionButton
                      disabled={dirty}
                      label="Yes, withdraw it"
                      pending={withdrawing}
                      pendingAnnouncement="Withdrawing this profile."
                      pendingLabel="Withdrawing…"
                      onClick={() => void withdraw()}
                      variant="danger"
                    />
                    <Button
                      onClick={() => setConfirmingWithdraw(false)}
                      variant="ghost"
                    >
                      Keep it published
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  disabled={dirty}
                  onClick={() => setConfirmingWithdraw(true)}
                  variant="secondary"
                >
                  Withdraw published profile
                </Button>
              )}
            </div>
          ) : null}

          {selected.lifecycle === "active" ? (
            <div className="author-profile-archive">
              <h3>Archive profile</h3>
              <p>
                Archive removes this identity from new bylines and withdraws its
                public snapshot. Existing bylines, the author id and every
                reserved slug remain.
              </p>
              {confirmingArchive ? (
                <div
                  className="author-profile-confirm"
                  role="group"
                  aria-label="Confirm archive profile"
                >
                  <AsyncActionButton
                    disabled={dirty}
                    label="Yes, archive profile"
                    pending={lifecycleAction === "archive"}
                    pendingAnnouncement="Archiving this profile."
                    pendingLabel="Archiving…"
                    onClick={() => void runLifecycleAction("archive")}
                    variant="danger"
                  />
                  <Button
                    onClick={() => setConfirmingArchive(false)}
                    variant="ghost"
                  >
                    Keep profile active
                  </Button>
                </div>
              ) : (
                <Button
                  disabled={dirty}
                  onClick={() => setConfirmingArchive(true)}
                  variant="secondary"
                >
                  Archive profile
                </Button>
              )}
            </div>
          ) : null}

          {selected.lifecycle === "active" &&
          selected.uid === null &&
          selected.visibility === "private" &&
          selected.slug === null ? (
            <div className="author-profile-delete">
              <h3>Delete draft permanently</h3>
              <p>
                Deletion succeeds only if this draft has never been published
                and no post references it. Otherwise, archive it.
              </p>
              {confirmingDelete ? (
                <div
                  className="author-profile-confirm"
                  role="group"
                  aria-label="Confirm permanent profile deletion"
                >
                  <AsyncActionButton
                    disabled={dirty}
                    label="Yes, delete draft permanently"
                    pending={lifecycleAction === "delete"}
                    pendingAnnouncement="Deleting this draft profile."
                    pendingLabel="Deleting…"
                    onClick={() => void deleteDraft()}
                    variant="danger"
                  />
                  <Button
                    onClick={() => setConfirmingDelete(false)}
                    variant="ghost"
                  >
                    Keep draft
                  </Button>
                </div>
              ) : (
                <Button
                  disabled={dirty}
                  onClick={() => setConfirmingDelete(true)}
                  variant="secondary"
                >
                  Delete draft permanently
                </Button>
              )}
            </div>
          ) : null}
              </Panel>
            </aside>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function AuthorProfilesRoute() {
  return (
    <RequireCapability
      allowed={canManageAuthorProfiles}
      notice="Staff profiles aren't available for your account."
    >
      <AuthorProfilesSurface />
    </RequireCapability>
  );
}
