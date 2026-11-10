import { parseBannerText, type BannerText } from "../../../packages/content-core/src/live-production";

export type SourceConfig = { documentId: string; tabIds: string[]; enabled: boolean };
export type SourceView = { source: { configVersion: number; generation: number; config: SourceConfig | null;
  status: string; nextAttemptAtMs: number; checkedAtMs: number | null };
  snapshot: { hash: string; diagnostics: { code: string }[]; expiresAtMs: number } | null; serverNowMs: number };
export type ReviewTarget = { bannerId: string; baseVersion: number; text: BannerText; order: number; protectedFields: string[]; sourceContext?: string };
export type RundownChange = { id: string; fingerprint: string; status: "NEW" | "CHANGED" | "MOVED" | "REMOVED" | "AMBIGUOUS";
  target: ReviewTarget | null; possibleTargets: ReviewTarget[]; reasons: string[];
  candidate: { id: string; text: BannerText | null; rawLines: string[]; tabTitle: string; segmentTitle: string; order: number;
    passages: { sourceId: string; location: string; text: string }[] } | null };
export type RundownReview = { version: number; sourceGeneration: number; sourceHash: string; changes: RundownChange[]; expiresAtMs: number };
export type RundownDecision = { action: "accept" | "ignore"; sessionId: string; requestId: string; sourceGeneration: number;
  reviewVersion: number; suggestionId: string; baseVersion: number; text?: BannerText; targetBannerId?: string; overrideFields?: string[]; editedFields?: string[] };
export function proposalBaseline(candidate: NonNullable<RundownChange["candidate"]>, templateId: BannerText["templateId"]): BannerText {
  if (candidate.text?.templateId === templateId) return candidate.text;
  return templateId === "headline" ? { templateId, headline: candidate.rawLines.join("\n") } :
    { templateId, name: candidate.rawLines[0] ?? "", title: candidate.rawLines.slice(1).join("\n") };
}
export function proposalEditedFields(candidate: NonNullable<RundownChange["candidate"]>, text: BannerText): string[] {
  const baseline = proposalBaseline(candidate, text.templateId) as Record<string, string>;
  return Object.entries(text).filter(([key, value]) => key !== "templateId" && value !== baseline[key]).map(([key]) => key);
}
type Endpoint = "cmsRundownSource" | "cmsRundownParser" | "cmsRundownReview";
export interface RundownClient {
  source(sessionId: string, signal?: AbortSignal): Promise<SourceView>;
  configure(sessionId: string, baseConfigVersion: number, config: SourceConfig, signal?: AbortSignal): Promise<SourceView>;
  refresh(sessionId: string, manual: boolean, signal?: AbortSignal): Promise<SourceView>;
  extract(sessionId: string, sourceGeneration: number, signal?: AbortSignal): Promise<void>;
  reconcile(sessionId: string, sourceGeneration: number, signal?: AbortSignal): Promise<RundownReview>;
  decide(request: RundownDecision, signal?: AbortSignal): Promise<{ decision: string; bannerId: string | null; draftVersion: number | null }>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rundown response.");
  return value as Record<string, unknown>;
};
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid rundown version.");
  return value as number;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Invalid rundown context.");
  return value;
}
function target(value: unknown): ReviewTarget {
  const data = object(value);
  if (typeof data.bannerId !== "string") throw new Error("Invalid draft identity.");
  if (data.sourceContext !== undefined && typeof data.sourceContext !== "string") throw new Error("Invalid source context.");
  return { bannerId: data.bannerId, baseVersion: integer(data.baseVersion), text: parseBannerText(data.text), order: integer(data.order), protectedFields: strings(data.protectedFields) };
}
export function parseSourceView(value: unknown): SourceView {
  const data = object(value), source = object(data.source);
  for (const key of ["configVersion", "generation", "nextAttemptAtMs"]) integer(source[key]);
  if (typeof source.status !== "string") throw new Error("Invalid source status.");
  if (source.config !== null) {
    const config = object(source.config);
    if (typeof config.documentId !== "string" || typeof config.enabled !== "boolean") throw new Error("Invalid source settings.");
    strings(config.tabIds);
  }
  if (data.snapshot !== null) {
    const snapshot = object(data.snapshot);
    if (typeof snapshot.hash !== "string" || !Array.isArray(snapshot.diagnostics)) throw new Error("Invalid source read.");
    integer(snapshot.expiresAtMs);
  }
  integer(data.serverNowMs);
  return data as unknown as SourceView;
}
export function parseRundownReview(value: unknown): RundownReview {
  const data = object(object(value).review);
  integer(data.version); integer(data.sourceGeneration); integer(data.expiresAtMs);
  if (typeof data.sourceHash !== "string" || !Array.isArray(data.changes) || data.changes.length > 200) throw new Error("Invalid rundown review.");
  for (const value of data.changes) {
    const change = object(value);
    if (typeof change.id !== "string" || typeof change.fingerprint !== "string" || !["NEW", "CHANGED", "MOVED", "REMOVED", "AMBIGUOUS"].includes(String(change.status))) throw new Error("Invalid rundown suggestion.");
    if (change.target !== null) target(change.target);
    if (!Array.isArray(change.possibleTargets)) throw new Error("Invalid identity choices.");
    change.possibleTargets.forEach(target); strings(change.reasons);
    if (change.candidate !== null) {
      const candidate = object(change.candidate);
      if (candidate.text !== null) parseBannerText(candidate.text);
      strings(candidate.rawLines); integer(candidate.order);
      if (typeof candidate.tabTitle !== "string" || typeof candidate.segmentTitle !== "string" || !Array.isArray(candidate.passages)) throw new Error("Invalid source passage.");
      for (const passage of candidate.passages) if (typeof object(passage).text !== "string") throw new Error("Invalid source text.");
    }
  }
  return data as unknown as RundownReview;
}
export function createRundownClient(call: (endpoint: Endpoint, body: object, signal?: AbortSignal) => Promise<unknown>): RundownClient {
  return {
    source: async (sessionId, signal) => parseSourceView(await call("cmsRundownSource", { action: "get_source", sessionId }, signal)),
    configure: async (sessionId, baseConfigVersion, config, signal) => parseSourceView(await call("cmsRundownSource", { action: "set_source", sessionId, baseConfigVersion, config }, signal)),
    refresh: async (sessionId, manual, signal) => parseSourceView(await call("cmsRundownSource", { action: "refresh_source", sessionId, manual }, signal)),
    extract: async (sessionId, sourceGeneration, signal) => { await call("cmsRundownParser", { sessionId, sourceGeneration }, signal); },
    reconcile: async (sessionId, sourceGeneration, signal) => parseRundownReview(await call("cmsRundownReview", { action: "reconcile", sessionId, sourceGeneration }, signal)),
    decide: async (request, signal) => {
      const result = object(await call("cmsRundownReview", request, signal));
      if (typeof result.decision !== "string" || (result.bannerId !== null && typeof result.bannerId !== "string") ||
        (result.draftVersion !== null && !Number.isSafeInteger(result.draftVersion))) throw new Error("Decision receipt is unavailable. Retry the same decision.");
      return result as { decision: string; bannerId: string | null; draftVersion: number | null };
    },
  };
}
export function validSourceConfig(config: SourceConfig): boolean {
  const valid = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
  return valid(config.documentId) && config.tabIds.length > 0 && config.tabIds.length <= 10 &&
    config.tabIds.every(id => /^[A-Za-z0-9_.-]{1,128}$/.test(id)) && new Set(config.tabIds).size === config.tabIds.length;
}
