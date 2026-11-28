import type { Capability } from "../../../packages/content-core/src/rbac";

/**
 * Plain-language phrase for every capability, keyed by Capability so a new permission
 * added to the model cannot ship without a label (the Record type makes the omission a
 * compile error, the same discipline rbac.ts uses for its scope table). Each phrase is a
 * verb clause that reads correctly in a list and after "the ability to".
 */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "guide.view": "view the private Boardwalk guide",
  "content.view": "read content across the whole site",
  "media.image.read": "browse Images and documents",
  "content.create": "create content",
  "content.edit.own": "edit their own content",
  "content.edit.any": "edit anyone's content",
  "content.publish": "publish content",
  "content.unpublish": "unpublish content",
  "content.delete": "delete content",
  "datasets.approve": "approve dataset revisions",
  "media.upload": "upload media site-wide",
  "media.manage": "manage the media library site-wide",
  "media.video.read": "browse station videos site-wide",
  "media.video.manage": "manage station videos site-wide",
  "submissions.review": "review public submissions",
  "reports.view": "file and view their own problem reports",
  "analytics.view": "view site analytics",
  "profiles.manage": "manage staff profiles",
  "media.audio.read": "browse station audio site-wide",
  "schedule.manage": "manage the broadcast schedule",
  "members.view": "view member records",
  "settings.manage": "manage site settings",
  "users.view": "view staff accounts",
  "users.manage": "manage staff accounts",
  "audit.view": "view administrative activity",
  "roles.grant": "change staff access levels",
};
