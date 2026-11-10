export interface AdminBuildRevisionInput {
  manifest?: { build?: { revision?: string | null } | null } | null;
  gitRevision?: string | null;
}

export function resolveAdminBuildRevision(
  input?: AdminBuildRevisionInput,
): string | null;
