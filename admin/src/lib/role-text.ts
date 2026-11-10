import type { Role } from "../../../packages/content-core/src/rbac";

// Staff words only. The role ids and capability checks stay in the shared RBAC model.
export const ROLE_TEXT: Record<Role, {
  name: string;
  summary: string;
  can: readonly string[];
  cannot: readonly string[];
}> = {
  staff: {
    name: "Viewer",
    summary: "Can read the guide and browse authorized audio. Cannot change content.",
    can: ["Read the private Boardwalk guide.", "Browse audio in authorized categories.", "File problem reports and read their own reports."],
    cannot: ["Create, edit or publish content.", "Upload or manage media.", "Manage the schedule, settings, staff accounts or access."],
  },
  contributor: {
    name: "Writer",
    summary: "Can draft and edit their own work. An Editor publishes it.",
    can: ["Read the guide and browse authorized audio.", "Draft and edit their own work in their areas.", "Manage their own profile and profile photo."],
    cannot: ["Edit other people's work or publish pages and posts.", "Delete content or manage media.", "Upload media beyond their own profile photo.", "Manage the schedule, settings, staff accounts or access."],
  },
  editor: {
    name: "Editor",
    summary: "Can edit and publish any work in their areas, and manage media in authorized categories. Cannot manage staff access.",
    can: ["Read the guide and browse authorized audio.", "Draft, edit, publish and unpublish work in their areas.", "Upload and manage media in authorized categories."],
    cannot: ["Delete content.", "Manage the schedule, settings, staff accounts or access."],
  },
  admin: {
    name: "Manager",
    summary: "Can also delete content, manage the schedule and settings, view staff accounts and manage staff profiles. Cannot give access.",
    can: ["Do everything an Editor can do.", "Delete content and manage the broadcast schedule and site settings.", "View staff accounts and manage staff profiles.", "View member records and administrative activity."],
    cannot: ["Approve account requests or deactivate staff accounts.", "Grant or revoke roles.", "Change their own administrative role."],
  },
  super_admin: {
    name: "Site owner",
    summary: "Can do everything available in Boardwalk, including give access. Cannot change their own administrative role.",
    can: ["Do everything a Manager can do.", "Grant and revoke staff roles and access to areas."],
    cannot: ["Change their own administrative role or revoke their own roles.", "Remove the last Site owner."],
  },
};

/** Unknown grants remain visible without acquiring a recognized role's name. */
export function roleDisplayName(role: string): string {
  return Object.hasOwn(ROLE_TEXT, role) ? ROLE_TEXT[role as Role].name : `Unknown role (${role})`;
}
