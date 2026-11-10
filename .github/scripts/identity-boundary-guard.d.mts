export type IdentityBoundaryViolation = {
  rule:
    | "identity-owner-unreadable"
    | "identity-owner-empty"
    | "identity-scan-root-unreadable"
    | "member-imports-staff-identity"
    | "staff-imports-member-gate"
    | "listed-owner-not-scanned"
    | "identity-owner-unclassified";
  owner: string;
  target: string | null;
  message: string;
};

export const ADR: string;
export const MEMBER_GATE: readonly string[];
export const STAFF_IDENTITY: readonly string[];
export const EXECUTABLE_SOURCE_EXTENSION: RegExp;
export const SCAN_ROOTS: readonly string[];
export const EXEMPT_NON_OWNERS: readonly string[];

export function withoutExecutableExtension(path: string): string;
export function stripComments(source: string): string;
export function cookStringLiteral(raw: string): string;
export function localImportTargets(ownerPath: string, source: string): string[];
export function identityBoundaryViolations(
  root?: string,
): IdentityBoundaryViolation[];
export function formatIdentityBoundaryViolations(
  violations: readonly IdentityBoundaryViolation[],
): string;
