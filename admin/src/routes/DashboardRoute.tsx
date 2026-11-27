import { useCallback } from "react";
import { can } from "../../../packages/content-core/src/rbac";
import { HomeShortcuts } from "../components/HomeShortcuts";
import { readHomeShortcuts } from "../lib/home-shortcuts";
import { saveHomeShortcuts } from "../lib/home-shortcuts-store";
import { NewsroomHome } from "../components/NewsroomHome";
import { useAuth } from "../context/AuthContext";
import {
  canBrowseContentPages,
  canManageContentRecords,
  canSaveContent,
  canAccessMediaWorkspace,
  canUseContentStudio,
  canViewAudit,
  canViewPublishActivity,
} from "../lib/access";
import { fetchAdminStatus } from "../lib/admin-status";
import { DEFAULT_CONTENT_QUERY, encodeContentQuery } from "../lib/content-query";
import { MY_DRAFTS_QUERY } from "../components/HomeDrafts";
import type { ContentRecordSummary } from "../lib/content-records";
import { cmsBulkArchiveContent, cmsGetNewsroomBanner, cmsListContent } from "../lib/functions";
import { loadPublishActivitySummary } from "../lib/publish-activity";
import { useShell } from "./ShellContext";

// The signed-in landing page is an editorial work surface, not an account/capability report.
export function DashboardRoute() {
  const { principal, user, userDoc } = useShell();
  const { getIdToken } = useAuth();
  const canBrowseRecords = canUseContentStudio(principal);
  const loadRecords = useCallback(async () => {
    const idToken = await getIdToken();
    // Page one supplies the bounded recent-work rows. The same response carries
    // authoritative status, mine, and assignment counts across every visible record.
    return cmsListContent(idToken, encodeContentQuery(DEFAULT_CONTENT_QUERY));
  }, [getIdToken]);
  const loadDrafts = useCallback(async () => {
    const idToken = await getIdToken();
    return cmsListContent(idToken, encodeContentQuery(MY_DRAFTS_QUERY));
  }, [getIdToken]);
  const archiveDraft = useCallback(async (draft: ContentRecordSummary & { version: number }) => {
    const idToken = await getIdToken();
    const response = await cmsBulkArchiveContent(idToken, [{ id: draft.id, baseVersion: draft.version }]);
    return response.outcomes.find(outcome => outcome.id === draft.id);
  }, [getIdToken]);
  const loadHomeSettings = useCallback(async () => {
    const idToken = await getIdToken();
    const response = await cmsGetNewsroomBanner(idToken);
    return {
      heading: response.heading,
      milestoneNumber: response.milestoneNumber,
    };
  }, [getIdToken]);
  const loadAdminStatus = useCallback(
    async () => fetchAdminStatus(await getIdToken()),
    [getIdToken],
  );
  return (
    <NewsroomHome
      homeActions={
        <HomeShortcuts
          key={user.uid}
          principal={principal}
          stored={readHomeShortcuts(userDoc?.preferences)}
          onSave={ids => saveHomeShortcuts(user.uid, ids)}
        />
      }
      canBrowsePages={canBrowseContentPages(principal)}
      canEditHomepage={can(principal, "content.edit.any", { section: "station" })}
      canBrowseRecords={canBrowseRecords}
      canCreate={canBrowseRecords && canSaveContent(principal)}
      canUseMediaLibrary={canAccessMediaWorkspace(principal)}
      canViewActivity={canViewAudit(principal)}
      canViewPublishActivity={canViewPublishActivity(principal)}
      currentUserId={user.uid}
      loadRecords={loadRecords}
      loadDrafts={loadDrafts}
      archiveDraft={canManageContentRecords(principal) ? archiveDraft : undefined}
      loadPublishActivity={async () => loadPublishActivitySummary(await getIdToken())}
      loadHomeSettings={loadHomeSettings}
      loadAdminStatus={loadAdminStatus}
    />
  );
}
