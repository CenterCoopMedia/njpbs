import type { CuezApi, CuezChoice, CuezOperation, CuezPreview, CuezStory } from "../lib/cuez-transfers";

export function createCuezFixtureApi(mode = "ready"): CuezApi {
  const long = mode === "long";
  const title = long ? "A statewide conversation about local reporting, election access, public service, and the people keeping their communities informed across New Jersey" : "Community reporting in New Jersey";
  const story: CuezStory = { id: "sample-story", title, description: "Reporting notes and source material for the newsroom.", descriptionTooLong: false,
    link: "https://storydesk.example.test/story" };
  const messages = { conflict: "The saved versions differ. Review both items before transferring again.", reconciliation: "The result needs review. Check StoryDesk before taking another action.", failed: "The transfer could not finish. Try again." };
  let sequence = 6;
  const operations: CuezOperation[] = mode === "empty" ? [] : (["queued", "transferring", "complete", "conflict", "reconciliation", "failed"] as const).map((state, index) => ({
    operationId: String(index + 1).repeat(64), direction: state === "complete" ? "import" : "export", kind: state === "complete" ? "story" : "video", state,
    label: index % 2 ? "Statehouse interview" : title,
    errorCode: state === "failed" ? "transient_failure" : state === "conflict" ? "remote_conflict" : state === "reconciliation" ? "outcome_unknown" : null,
    message: state in messages ? messages[state as keyof typeof messages] : null, canRetry: state === "failed", canClosePartial: state === "conflict", acknowledged: false,
    updatedAt: "2026-10-29T17:00:00Z", ...(state === "complete" ? { draftId: "sample-private-draft" } : {}),
  }));
  function operation(direction: "import" | "export", kind: CuezOperation["kind"]): CuezOperation {
    const value: CuezOperation = { operationId: (++sequence).toString(16).repeat(64).slice(0, 64), direction, kind, label: title,
      state: "queued", errorCode: null, message: null, canRetry: false, updatedAt: "2026-10-29T17:05:00Z", acknowledged: false };
    operations.unshift(value); return value;
  }
  const finish = async (operationId: string) => {
    const value = operations.find(item => item.operationId === operationId)!;
    Object.assign(value, { state: "complete", errorCode: null, message: null, canRetry: false,
      ...(value.direction === "import" ? { draftId: "sample-private-draft" } : {}) });
    return { operation: { ...value } };
  };
  return {
    status: async () => {
      if (mode === "off") throw Object.assign(new Error("StoryDesk transfers are turned off."), { data: { enabled: false } });
      if (mode === "error") throw new Error("StoryDesk is unavailable. Try status again.");
      if (mode === "pending") return new Promise(() => {});
      return { enabled: true, canImport: mode !== "reader" };
    },
    resources: async (kind, assetId) => {
      const items: CuezChoice[] = mode === "empty" ? [] : assetId ? [{ resource: { kind, id: assetId, jobId: "a".repeat(64) },
        label: kind === "clip" ? "Clip 5–12 seconds" : "Cached transcript (English)", detail: "Ready output" }]
        : [1, 2, 3].map((number) => ({ resource: { kind, id: `sample-item-${number}` }, label: number === 1 ? title : ["", "", "Statehouse interview", "Newsroom update"][number],
          detail: kind === "post" ? "Private draft" : "A prepared web viewing copy" }));
      return { items, nextCursor: null };
    },
    stories: async (_search, page) => ({ stories: mode === "empty" ? [] : [story], page, totalPages: 1 }),
    prepare: async resource => ({ operation: operation("export", resource.kind) }),
    send: finish,
    operations: async () => ({ operations: operations.map(value => ({ ...value })), nextCursor: null, boundary: operations.at(-1) ?? null }),
    preview: async (): Promise<CuezPreview> => ({ operation: operation("import", "story"), story,
      brief: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "The newsroom is preparing a story about public service reporting across the state." }] }] },
      dossiers: [{ id: "sample-dossier", title: "Interview notes", document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep the original source attribution with the reporting notes." }] }] } }],
      warnings: ["StoryDesk's Brief read omits embedded media, feed items, story references, and mention identities."] }),
    confirm: finish, retry: finish,
    reconcile: async (operationId, closePartial) => {
      const value = operations.find(item => item.operationId === operationId)!;
      Object.assign(value, closePartial ? { partialAcknowledged: true, canClosePartial: false, canRetry: false } : { acknowledged: true });
      return { operation: { ...value } };
    },
  };
}
