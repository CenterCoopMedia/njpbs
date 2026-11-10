import type { CuezOperation, CuezOperationPage } from "./cuez-transfers";

interface Scan {
  cursor: string;
  seen: Set<string>;
  anchors?: Map<string, string | null>;
}
export interface OperationPages {
  operations: CuezOperation[];
  positions: Map<string, string | null>;
  scans: Scan[];
  newestIds: Set<string>;
  newestCursor: string | null;
  loaded: boolean;
  error: string | null;
  focusStatus: boolean;
}
export const initialOperationPages: OperationPages = {
  operations: [], positions: new Map(), scans: [], newestIds: new Set(), newestCursor: null,
  loaded: false, error: null, focusStatus: false,
};
export type OperationPagesAction =
  | { type: "page"; page: CuezOperationPage; cursor?: string }
  | { type: "result"; operation: CuezOperation }
  | { type: "loading" }
  | { type: "focused" };

export function operationPages(state: OperationPages, action: OperationPagesAction): OperationPages {
  if (action.type === "loading") return { ...state, error: null, focusStatus: false };
  if (action.type === "focused") return { ...state, focusStatus: false };
  const byId = new Map(state.operations.map(item => [item.operationId, item]));
  if (action.type === "result") {
    byId.set(action.operation.operationId, action.operation);
    return { ...state, operations: sorted(byId), focusStatus: false };
  }
  const { page, cursor } = action;
  let scans = state.scans;
  let newestIds = state.newestIds;
  let newestCursor = state.newestCursor;
  if (cursor) {
    const scan = scans[0];
    if (!scan || scan.cursor !== cursor) return state;
    if (page.nextCursor && (page.nextCursor === cursor || scan.seen.has(page.nextCursor))) {
      return { ...state, error: "Older transfers could not advance. Refresh transfer status and try again.", focusStatus: false };
    }
    // A gap rejoins only a row at its saved position, never a row moved by retry.
    const joined = scan.anchors && page.operations.some(item =>
      scan.anchors!.has(item.operationId) && scan.anchors!.get(item.operationId) === item.updatedAt);
    scans = !page.nextCursor ? [] : joined ? scans.slice(1)
      : [{ ...scan, cursor: page.nextCursor, seen: new Set([...scan.seen, cursor]) }, ...scans.slice(1)];
  } else {
    newestIds = new Set(page.operations.map(item => item.operationId));
    newestCursor = page.nextCursor;
    const joined = page.operations.some(item => state.positions.has(item.operationId) && state.positions.get(item.operationId) === item.updatedAt);
    if (!page.nextCursor) scans = [];
    else if (!state.loaded) scans = [{ cursor: page.nextCursor, seen: new Set() }];
    else if (!joined && page.nextCursor !== state.newestCursor) {
      // Keep every unfinished scan underneath the new gap, including its anchors.
      scans = [{ cursor: page.nextCursor, seen: new Set(),
        anchors: state.positions }, ...scans];
    }
    for (const id of state.newestIds) {
      const item = byId.get(id);
      const floor = page.boundary;
      const insidePage = !page.nextCursor || (floor && item?.updatedAt && floor.updatedAt &&
        (item.updatedAt > floor.updatedAt || (item.updatedAt === floor.updatedAt && id >= floor.operationId)));
      if (!newestIds.has(id) && insidePage) byId.delete(id);
    }
  }
  const positions = new Map(state.positions);
  for (const item of page.operations) { byId.set(item.operationId, item); positions.set(item.operationId, item.updatedAt); }
  return { operations: sorted(byId), positions, scans, newestIds, newestCursor, loaded: true, error: state.error,
    focusStatus: !!cursor && scans.length === 0 };
}

function sorted(byId: Map<string, CuezOperation>): CuezOperation[] {
  return [...byId.values()].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
    right.operationId.localeCompare(left.operationId));
}
