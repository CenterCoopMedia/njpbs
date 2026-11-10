// Compatibility entry point for the original site-side tests and research references.
// Runtime consumers use the shared core so the public site and Admin CMS cannot drift.
export { diffStates } from "../../../packages/content-core/src/audit-diff";
export type {
  AuditDiff,
  FieldChange,
  Json,
} from "../../../packages/content-core/src/audit-diff";
