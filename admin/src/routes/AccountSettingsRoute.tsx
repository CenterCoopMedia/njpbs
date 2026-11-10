import { cmsListContent, cmsListPages } from "../lib/functions";
import { DEFAULT_CONTENT_QUERY, encodeContentQuery } from "../lib/content-query";
import { canBrowseContentPages, canUseContentStudio } from "../lib/access";
import type { SearchNavigationContent } from "../components/CustomNavigationEditor";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavigationPreferences } from "../components/NavigationPreferences";
import { Icon } from "../components/ui/Icon";
import {
  AsyncActionButton,
  InlineMessage,
  Panel,
} from "../components/ui/Primitives";
import {
  readControlPresentation,
  type ControlPresentation,
} from "../lib/control-presentation";
import { saveControlPresentation } from "../lib/control-presentation-store";
import { eligibleNavDestinations } from "../lib/nav-destinations";
import {
  readNavigationPreferences,
  type NavigationPreferences as StoredNavigationPreferences,
} from "../lib/navigation-preferences";
import {
  resetNavigationPreferences,
  saveNavigationPreferences,
  shareNavigationItem,
} from "../lib/navigation-preferences-store";
import { useNavigationShares } from "../lib/navigation-shares-store";
import type { CustomNavItem } from "../lib/custom-navigation";
import { useShell } from "./ShellContext";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";

// Account connections share this lazy entry.
export { PremiereConnectRoute } from "./PremiereConnectRoute";

const OPTIONS: Array<{
  value: ControlPresentation;
  label: string;
  description: string;
}> = [
  {
    value: "text",
    label: "Text labels",
    description: "Show the action name on eligible controls. Phones always show icons.",
  },
  {
    value: "icons",
    label: "Icons",
    description: "Use named icons on eligible controls to save space.",
  },
];

const navigationPreferencesEnabled = import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT !== "development";

type SaveStatus = "idle" | "saved" | "error";

export function AccountSettingsRoute() {
  const successNotice = useSuccessNotice();
  const { principal, user, userDoc, getIdToken, navigationShares: injectedShares } = useShell();
  const { shares, ready: sharesReady } = useNavigationShares(injectedShares, navigationPreferencesEnabled && Boolean(getIdToken), readNavigationPreferences(userDoc)?.shared);
  const searchNavigationContent = useMemo<SearchNavigationContent>(() => {
    let pageResults: { query: string; items: { id: string; label: string }[] } | null = null;
    return async (kind, query, page, refresh = false) => {
      if (!getIdToken) throw new Error("Content search is unavailable. Sign in again.");
      if (kind === "page") {
        if (!canBrowseContentPages(principal)) throw new Error("You cannot browse pages with this account.");
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (refresh || pageResults?.query !== normalizedQuery) {
          const result = await cmsListPages(await getIdToken());
          pageResults = {
            query: normalizedQuery,
            items: result.pages.filter(entry => entry.title.toLocaleLowerCase().includes(normalizedQuery))
              .map(entry => ({ id: entry.id, label: entry.title })),
          };
        }
        return { items: pageResults.items.slice((page - 1) * 25, page * 25), pageCount: Math.max(1, Math.ceil(pageResults.items.length / 25)) };
      }
      if (!canUseContentStudio(principal)) throw new Error("You cannot browse posts with this account.");
      const result = await cmsListContent(await getIdToken(), encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, types: ["post"], statuses: [], q: query.trim(), page }));
      return { items: result.records.map(entry => ({ id: entry.id, label: entry.title })), pageCount: result.pageCount };
    };
  }, [getIdToken, principal]);
  const stored = readControlPresentation(userDoc);
  // The rail arrangement comes from the same live profile document, so a save here reaches the
  // rail on the next listener event without this route holding its own copy of the truth.
  const eligibleDestinations = useMemo(
    () => eligibleNavDestinations(principal),
    [principal],
  );
  const storedNavigation = useMemo(
    () => readNavigationPreferences(userDoc),
    [userDoc],
  );
  const saveNavigation = useCallback(
    async (preferences: StoredNavigationPreferences) => {
      await saveNavigationPreferences(getIdToken, preferences);
    },
    [getIdToken],
  );
  const resetNavigation = useCallback(async () => {
    await resetNavigationPreferences(getIdToken);
  }, [getIdToken]);
  const shareNavigation = useCallback(async (item: CustomNavItem, shared: boolean) => {
    if (!getIdToken) return;
    const noun = item.kind === "section" ? "span" : "plank";
    const failed = shared ? `This ${noun} could not be shared. Try again.` : "Sharing could not be stopped. Try again.";
    if (!sharesReady || !storedNavigation?.custom?.some((entry) => entry.id === item.id)) throw new Error(failed);
    try {
      await shareNavigationItem(getIdToken, item.id, shared);
    } catch {
      throw new Error(failed);
    }
  }, [getIdToken, sharesReady, storedNavigation]);
  const [confirmed, setConfirmed] = useState<ControlPresentation>(stored);
  const [draft, setDraft] = useState<ControlPresentation>(stored);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saving, setSaving] = useState(false);
  const confirmedRef = useRef(confirmed);
  const savingRef = useRef(false);
  const deferredStoredRef = useRef<ControlPresentation | null>(null);

  useEffect(() => {
    // The profile listener can deliver a new document whose preference equals the value
    // that was present before this tab saved. Compare with the last confirmed local value,
    // not only the previous render's parsed value, so the final listener event still wins.
    // An unrelated profile refresh with the same confirmed preference does not erase an
    // unsaved radio choice.
    if (savingRef.current) {
      deferredStoredRef.current = stored;
      return;
    }
    if (stored === confirmedRef.current) return;
    confirmedRef.current = stored;
    setConfirmed(stored);
    setDraft(stored);
    setSaveStatus((current) => (current === "error" ? current : "idle"));
  }, [stored, userDoc]);

  function choose(value: ControlPresentation): void {
    setDraft(value);
    setSaveStatus("idle");
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savingRef.current || draft === confirmedRef.current) return;
    const requested = draft;
    const previousConfirmed = confirmedRef.current;
    savingRef.current = true;
    deferredStoredRef.current = null;
    setSaving(true);
    setSaveStatus("idle");
    try {
      await saveControlPresentation(user.uid, requested);
      const latestStored = deferredStoredRef.current ?? requested;
      confirmedRef.current = latestStored;
      setConfirmed(latestStored);
      setDraft(latestStored);
      setSaveStatus("saved");
      successNotice.show("Display preference saved.");
    } catch {
      const latestStored = deferredStoredRef.current ?? previousConfirmed;
      confirmedRef.current = latestStored;
      setConfirmed(latestStored);
      setDraft(latestStored);
      setSaveStatus("error");
    } finally {
      deferredStoredRef.current = null;
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="account-settings">
      <div className="surface-intro route-page-intro account-settings-intro">
        <div>
          <h2>Account settings</h2>
          <p>{navigationPreferencesEnabled
            ? "Choose how the CMS looks and arrange the navigation for this account."
            : "Choose how the CMS looks for this account."}</p>
        </div>
      </div>
      <Panel className="account-settings-panel" aria-labelledby="control-presentation-heading">
        <div className="panel-heading">
          <div>
            <h2 id="control-presentation-heading">Control presentation</h2>
            <p>
              Choose how eligible everyday controls appear in your CMS account.
              Important and uncommon actions keep their text labels.
            </p>
          </div>
        </div>

        <form className="control-presentation-form" onSubmit={save}>
          <fieldset className="control-presentation-fieldset" disabled={saving}>
            <legend>Control presentation</legend>
            <div className="control-presentation-options">
              {OPTIONS.map((option) => (
                <label
                  className="control-presentation-option"
                  data-selected={draft === option.value ? "true" : "false"}
                  key={option.value}
                >
                  <input
                    aria-describedby={`${option.value}-control-presentation-description`}
                    aria-labelledby={`${option.value}-control-presentation-label`}
                    checked={draft === option.value}
                    name="control-presentation"
                    onChange={() => choose(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span>
                    <strong id={`${option.value}-control-presentation-label`}>
                      {option.label}
                    </strong>
                    <span id={`${option.value}-control-presentation-description`}>
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="control-presentation-preview-panel">
            <div>
              <h3>Preview</h3>
              <p aria-live="polite">
                {draft === "icons"
                  ? "Eligible controls use named icons and retain accessible action names."
                  : "Eligible controls show the action name as text."}
              </p>
            </div>
            <div
              aria-label="Control presentation preview"
              className="control-presentation-preview"
              data-presentation={draft}
            >
              <span aria-label="Edit" className="control-preview-item" title="Edit">
                {draft === "icons" ? <Icon name="sliders" /> : "Edit"}
              </span>
              <span aria-label="Add" className="control-preview-item" title="Add">
                {draft === "icons" ? <Icon name="plus" /> : "Add"}
              </span>
            </div>
          </div>

          {saveStatus === "saved" && !successNotice.available ? (
            <InlineMessage tone="success">Display preference saved.</InlineMessage>
          ) : null}
          {saveStatus === "error" ? (
            <InlineMessage tone="error">
              Your display preference could not be stored. Try again.
            </InlineMessage>
          ) : null}

          <div className="account-settings-actions">
            <AsyncActionButton
              disabled={draft === confirmed}
              label="Save display preference"
              pending={saving}
              pendingAnnouncement="Saving display preference."
              pendingLabel="Saving…"
              type="submit"
              variant="primary"
            />
          </div>
        </form>
      </Panel>

      {navigationPreferencesEnabled && <NavigationPreferences
        searchContent={searchNavigationContent}
        eligible={eligibleDestinations}
        onReset={resetNavigation}
        onSave={saveNavigation}
        onShare={shareNavigation}
        shares={shares}
        sharesReady={sharesReady}
        stored={storedNavigation}
        viewerUid={user.uid}
      />}
    </div>
  );
}
