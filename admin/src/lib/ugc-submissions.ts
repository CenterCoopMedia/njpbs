import { postFunction } from "./functions";

export type UgcStatus = "pending" | "rejected" | "imported";
export type UgcRowStatus = UgcStatus | "importing" | "rejecting";

export interface UgcSubmission {
  id: string;
  name: string | null;
  email?: string;
  message: string | null;
  consentVersion: string;
  consentedAt: string | null;
  scopes: { broadcast: boolean; web: boolean; social: boolean };
  file: { name: string; type: string; size: number };
  status: UgcRowStatus;
  decisionCategory?: string;
  staleDecision?: boolean;
  createdAt: string | null;
  importedAsset?: { kind: "image" | "video"; id: string; sourceId?: string; duplicate?: boolean };
}

export interface UgcPage {
  success: true;
  records: UgcSubmission[];
  nextCursor: string | null;
}

export interface UgcPreview {
  success: true;
  mimeType: string;
  url: string;
  expiresAt: string;
}

export function listUgcSubmissions(token: string, status: UgcStatus | "all", cursor?: string) {
  return postFunction<UgcPage>("cmsListUgcSubmissions", token,
    { status, ...(cursor ? { cursor } : {}) }, {}, { appCheck: true });
}

export function getUgcSubmissionPreview(token: string, submissionId: string) {
  return postFunction<UgcPreview>("cmsGetUgcSubmissionPreview", token,
    { submissionId }, {}, { appCheck: true });
}

export function rejectUgcSubmission(token: string, submissionId: string) {
  return postFunction<{ success: true; status: "rejected" }>("cmsRejectUgcSubmission", token,
    { submissionId }, {}, { appCheck: true });
}

export function importUgcSubmission(token: string, submissionId: string, category: string) {
  return postFunction<{ success: true; status: "imported"; asset: NonNullable<UgcSubmission["importedAsset"]> }>(
    "cmsImportUgcSubmission", token, { submissionId, category }, {}, { appCheck: true });
}
