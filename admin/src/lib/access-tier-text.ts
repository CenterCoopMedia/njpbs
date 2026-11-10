import type { AccessTier } from "../../../packages/content-core/src/rbac";

export const ACCESS_TIER_TEXT: Record<AccessTier, { name: string; summary: string }> = {
  viewer: { name: "Viewer", summary: "Read non-admin destinations and shared media; comment. Cannot change content or upload media." },
  contributor: { name: "Contributor", summary: "Viewer access, plus draft, preview and submit their own work; upload and manage media. Cannot publish or edit another person's work." },
  editor: { name: "Editor", summary: "Contributor access, plus edit anyone's content and review submissions. Cannot publish, withdraw or delete content." },
  publisher: { name: "Publisher", summary: "Editor access, plus publish, withdraw and delete content. Cannot change administrative settings or staff access." },
  admin: { name: "Admin", summary: "Publisher access, plus settings, schedule, staff profiles, staff directory and audit reads. Cannot give access or deactivate accounts." },
  owner: { name: "Owner", summary: "Admin access, plus give access and deactivate accounts. Cannot change their own access or remove the last Owner." },
};
