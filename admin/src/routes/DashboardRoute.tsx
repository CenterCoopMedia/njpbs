import { useCallback } from "react";
import { can } from "../../../packages/content-core/src/rbac";
import { HomeShortcuts } from "../components/HomeShortcuts";
import { readHomeShortcuts } from "../lib/home-shortcuts";
import { saveHomeShortcuts } from "../lib/home-shortcuts-store";
import { NewsroomHome } from "../components/NewsroomHome";
import { useAuth } from "../context/AuthContext";
import {
  canBrowseContentPages,
  canSaveContent,
  canAccessMediaWorkspace,
  canUseContentStudio,
  canViewAudit,
  canViewEditorialQueue,
  canViewPublishActivity,
} from "../lib/access";
import { fetchAdminStatus } from "../lib/admin-status";
import { DEFAULT_CONTENT_QUERY, encodeContentQuery } from "../lib/content-query";
import { cmsGetNewsroomBanner, cmsListContent } from "../lib/functions";
import { loadPublishActivitySummary } from "../lib/publish-activity";
import { cmsCountReviewQueue } from "../lib/review-queue";
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
  // The queue is the authoritative in-review projection and is already scoped to this reviewer's
  // grants on the server, so the count the card shows is the number of rows they will actually
  // see after following it.
  const loadReviewRequestCount = useCallback(async () => {
    const idToken = await getIdToken();
    return cmsCountReviewQueue(idToken);
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
      canViewEditorialQueue={canViewEditorialQueue(principal)}
      canViewPublishActivity={canViewPublishActivity(principal)}
      currentUserId={user.uid}
      loadRecords={loadRecords}
      loadReviewRequestCount={loadReviewRequestCount}
      loadPublishActivity={async () => loadPublishActivitySummary(await getIdToken())}
      loadHomeSettings={loadHomeSettings}
      loadAdminStatus={loadAdminStatus}
    />
  );
}
