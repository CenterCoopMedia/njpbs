"use strict";

const { authorizeContentRead, contentResource } = require("./content-authorization");
const { can } = require("./rbac");
const { normalizedStoredReviewRequest } = require("./review-queue");
const { principalFromUserDoc } = require("./principal");
const { readAutomationAccount } = require("./automation-accounts");

const messages = {
  submit: ["Ready for review", "is ready for review", "Open Boardwalk to review the submitted draft."],
  sendBack: ["Changes requested", "was returned for changes", "Open Boardwalk to review the draft."],
  approve: ["Approved for publication", "was approved for publication", "Open Boardwalk to see the approved version."],
  schedule: ["Publication scheduled", "was scheduled for publication", "Open Boardwalk to see when it is scheduled to publish."],
  publish: ["Publication started", "was sent for publication", "Open Boardwalk to check the publication status."],
};

// Keep the contact information, draft text, and review comments out of the
// audit event. Resolve staff access and addresses after the commit.
function editorialNotice(collection, id, action, before, after) {
  if (!Object.hasOwn(messages, action) ||
      !(collection === "cmsPages" || collection === "cmsPosts" && after.type === "post")) {
    return {};
  }
  const resource = contentResource({ collection, documentId: id, stored: after });
  const requester = action === "sendBack" || action === "approve"
    ? normalizedStoredReviewRequest(collection, id, before?.reviewRequest)?.requestedBy ?? null
    : null;
  return {
    editorialNotice: {
      collection, id, action, requester,
      assignee: after.assignee ?? null,
      ownerId: resource.ownerId ?? null,
      section: resource.section ?? null,
    },
  };
}

function mayReceiveEditorialNotice(principal, notice) {
  const resource = { ownerId: notice.ownerId, section: notice.section ?? undefined };
  return notice.action === "submit"
    ? can(principal, "content.edit.any", resource)
    : authorizeContentRead(principal, { exists: true, resource }).allowed;
}

const staffAccessFields = ["active", "accessTier", "role", "grants"];

async function editorialRecipient(firestore, authClient, tiersActive, profile, notice) {
  if (!profile.exists ||
      !mayReceiveEditorialNotice(principalFromUserDoc(profile.id, profile.data(), tiersActive), notice) ||
      await readAutomationAccount(firestore, profile.id)) {
    return null;
  }
  try {
    const identity = await authClient.getUser(profile.id);
    return !identity.disabled && identity.emailVerified && identity.email
      ? { uid: profile.id, to: identity.email.trim().toLowerCase() }
      : null;
  } catch (error) {
    if (error.code === "auth/user-not-found") return null;
    throw error;
  }
}

function editorialEmailContent(notice, origin) {
  const [heading, change, nextStep] = messages[notice.action];
  const kind = notice.collection === "cmsPages" ? "page" : "post";
  const routeKind = kind === "page" ? "pages" : "post";
  const paragraphs = [`A ${kind} ${change} in Boardwalk.`, nextStep];
  return {
    preheader: nextStep,
    heading,
    paragraphs,
    ctaLabel: "Open in Boardwalk",
    ctaUrl: `${origin}/content/${routeKind}/${encodeURIComponent(notice.id)}/edit`,
  };
}

module.exports = { editorialNotice, editorialEmailContent, editorialRecipient, staffAccessFields };
