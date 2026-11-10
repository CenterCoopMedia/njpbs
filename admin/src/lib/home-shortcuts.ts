import type { Principal } from "../../../packages/content-core/src/rbac";
import { canAccessMediaWorkspace, canUseContentStudio, canViewGuide } from "./access";
import { DEFAULT_CONTENT_QUERY } from "./content-query";
import { contentLibraryPath, guidePath, mediaLibraryPath } from "./routes";

// Preferences contain stable IDs only. Routes and access always come from this registry.
const HOME_SHORTCUTS = [
  { id: "recent-edits", label: "My recent edits", to: contentLibraryPath({ ...DEFAULT_CONTENT_QUERY, ownerMode: "me" }), allowed: canUseContentStudio },
  { id: "assigned", label: "Assigned to me", to: contentLibraryPath({ ...DEFAULT_CONTENT_QUERY, assignmentMode: "me" }), allowed: canUseContentStudio },
  { id: "media", label: "Browse media", to: mediaLibraryPath(), allowed: canAccessMediaWorkspace },
  { id: "guide", label: "Open guide", to: guidePath(), allowed: canViewGuide },
] as const;

export type HomeShortcutId = typeof HOME_SHORTCUTS[number]["id"];
export type HomeShortcut = typeof HOME_SHORTCUTS[number];

export function eligibleHomeShortcuts(principal: Principal): HomeShortcut[] {
  return HOME_SHORTCUTS.filter((action) => action.allowed(principal));
}

export function readHomeShortcuts(preferences: unknown): unknown {
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return null;
  return (preferences as Record<string, unknown>).homeShortcuts;
}

/** Keep valid choices in their slot, then fill gaps from role-aware defaults. */
export function resolveHomeShortcuts(stored: unknown, eligible: readonly HomeShortcut[]): HomeShortcut[] {
  const ids = Array.isArray(stored) ? stored.slice(0, 2) : [];
  const slots = ids.map((id, index) => ids.indexOf(id) === index ? eligible.find((action) => action.id === id) : undefined);
  const used = new Set(slots.flatMap((action) => action ? [action.id] : []));
  return [0, 1].flatMap((index) => {
    const action = slots[index] ?? eligible.find((candidate) => !used.has(candidate.id));
    if (!action) return [];
    used.add(action.id);
    return [action];
  });
}
