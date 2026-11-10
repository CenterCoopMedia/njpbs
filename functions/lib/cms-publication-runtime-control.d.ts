export type RuntimeIdentity = { phase: "paused" | "starting" | "ready"; commitSha: string; serializerId: string };
export type RuntimeControl = RuntimeIdentity & { schemaVersion: 1; cloud?: RuntimeIdentity };
export function parseCmsPublicationRuntimeControl(value: unknown): RuntimeControl;
export function cloudCmsPublicationRuntimeControl(value: unknown): RuntimeIdentity;
export function assertCmsPublicationCloudAdmission(control: RuntimeControl | null, input: { commitSha: string; serializerId?: string }): RuntimeIdentity;
