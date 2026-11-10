export type CmsDeployCompatibility = {
  manifestSchemaVersion: number;
  editorLockContractVersion: number;
  firestoreRulesSha256: string;
};

export const CMS_DEPLOY_COMPATIBILITY_MANIFEST: string;
export const CMS_DEPLOY_COMPATIBILITY_SCHEMA_VERSION: number;
export const CMS_EDITOR_LOCK_CONTRACT_FLOOR: number;
export function cmsEditorLockRulesDigest(source: string, version?: number): string;
export function validateCmsDeployCompatibility(
  repoRoot: string,
): CmsDeployCompatibility;
export function verifyLivePublisher(
  repoRoot: string,
  receiptUrl: string,
): Promise<string>;

export function verifyVersionedCmsReaders(input: {
  cmsSourceSha: string;
  readLiveState: () => Promise<unknown>;
  replayDeployedReader: (input: unknown) => Promise<{ digest: string; readerDigest: string; stateDigest: string }>;
}): Promise<{ schemaVersion: number; candidateSourceSha: string; stateDigest: string; replays: Record<string, string>;
  readerDigests: Record<"functions" | "cmsApi", string> }>;
