import type { BannerText, LiveCommand, ProductionSession } from "../../../packages/content-core/src/live-production";
import { bannerEditDirty, liveBlockReason, reconcileBannerEdit, savedBannerEdit, type BannerEdit, type OrderedBanner, type TimedSessionView } from "./live-production-workspace";

export type CommandFailure = {
  action: "take" | "update_text" | "clear"; sequence: number; text: BannerText | null;
  refused: boolean; intent: number; message: string;
};
export type LiveWorkspaceState = {
  sessionId: string; rows: OrderedBanner[]; selectedId: string; edit: BannerEdit | null; detachedSelection: OrderedBanner | null;
  view: TimedSessionView | null; requested: LiveCommand | null; failure: CommandFailure | null;
  uncertainSessions: Record<string, CommandFailure>;
  acceptedIntent: number; busy: { save: boolean; take: boolean; update_text: boolean; clear: boolean };
  error: string | null; statusError: string | null;
};
export const initialLiveWorkspaceState: LiveWorkspaceState = {
  sessionId: "", rows: [], selectedId: "", edit: null, detachedSelection: null, view: null, requested: null,
  failure: null, uncertainSessions: {}, acceptedIntent: 0, busy: { save: false, take: false, update_text: false, clear: false }, error: null, statusError: null,
};
export type LiveWorkspaceAction =
  | { type: "session"; id: string }
  | { type: "banners"; rows: OrderedBanner[]; replace?: boolean }
  | { type: "select"; row: OrderedBanner }
  | { type: "edit"; edit: BannerEdit }
  | { type: "saved"; row: OrderedBanner }
  | { type: "added"; row: OrderedBanner }
  | { type: "archived"; row: OrderedBanner }
  | { type: "imported"; rows: OrderedBanner[]; replace: boolean }
  | { type: "session_ended"; session: ProductionSession }
  | { type: "status"; view: TimedSessionView }
  | { type: "status_error"; message: string }
  | { type: "invalidate" }
  | { type: "busy"; kind: "save" | "take" | "update_text" | "clear"; value: boolean }
  | { type: "accepted"; command: LiveCommand; intent: number }
  | { type: "failed"; failure: CommandFailure }
  | { type: "acknowledge"; now: number; connected: boolean }
  | { type: "error"; message: string | null };

function withoutObservation(view: TimedSessionView | null): TimedSessionView | null {
  return view ? { ...view, observed: { ...view.observed, state: "unknown", report: null } } : null;
}
// Own the draft baseline, accepted intent, uncertain outcomes and observation together.
// A newer attempt never supersedes an earlier outcome until the server accepts it.
export function liveWorkspaceReducer(state: LiveWorkspaceState, action: LiveWorkspaceAction): LiveWorkspaceState {
  switch (action.type) {
    case "session": {
      const uncertainSessions = { ...state.uncertainSessions,
        ...(state.failure && !state.failure.refused ? { [state.sessionId]: state.failure } : {}) };
      const failure = Object.hasOwn(uncertainSessions, action.id) ? uncertainSessions[action.id] : null;
      delete uncertainSessions[action.id];
      return { ...initialLiveWorkspaceState, sessionId: action.id, failure, uncertainSessions };
    }
    case "banners": {
      const previous = new Map(state.rows.map(row => [row.record.id, row]));
      const byId = action.replace ? new Map<string, OrderedBanner>() : new Map(previous);
      for (const incoming of action.rows) {
        const prior = previous.get(incoming.record.id);
        const row = prior && prior.record.draft.version > incoming.record.draft.version ? prior : incoming;
        if (row.archived) byId.delete(row.record.id); else byId.set(row.record.id, row);
      }
      const rows = [...byId.values()];
      const selected = byId.get(state.selectedId);
      // A refresh resets loaded pages. Keep an absent selection's unsaved work
      // outside the rundown until it is found on a later page or discarded.
      const detachedSelection = !selected && bannerEditDirty(state.edit)
        ? previous.get(state.selectedId) ?? state.detachedSelection : null;
      return { ...state, rows, detachedSelection,
        selectedId: selected || detachedSelection ? state.selectedId : "",
        edit: detachedSelection ? state.edit : reconcileBannerEdit(state.edit, selected) };
    }
    case "select": return { ...state, selectedId: action.row.record.id, detachedSelection: null, edit: savedBannerEdit(action.row) };
    case "edit": return { ...state, edit: action.edit };
    case "saved": return { ...state,
      rows: state.rows.map(row => row.record.id === action.row.record.id ? action.row : row),
      ...(state.selectedId === action.row.record.id ? { detachedSelection: null, edit: savedBannerEdit(action.row) } : {}) };
    case "added": return { ...state, rows: [...state.rows.filter(row => row.record.id !== action.row.record.id), action.row],
      selectedId: action.row.record.id, detachedSelection: null, edit: savedBannerEdit(action.row) };
    case "archived": return { ...state, rows: state.rows.filter(row => row.record.id !== action.row.record.id),
      ...(state.selectedId === action.row.record.id ? { selectedId: "", edit: null, detachedSelection: null } : {}) };
    case "imported": {
      if (!action.replace) return liveWorkspaceReducer(state, { type: "banners", rows: action.rows });
      return { ...state, rows: action.rows, selectedId: "", edit: null, detachedSelection: null };
    }
    case "session_ended": return { ...state, view: state.view ? { ...state.view, session: action.session,
      fences: { ...state.view.fences, active: false, sessionGeneration: action.session.generation },
      observed: { ...state.view.observed, state: "unknown", report: null } } : null };
    case "status": {
      if (state.view && action.view.session.generation < state.view.session.generation) return state;
      return { ...state, view: action.view, statusError: null };
    }
    case "invalidate": return { ...state, view: withoutObservation(state.view) };
    case "status_error": return { ...state, view: withoutObservation(state.view), statusError: action.message };
    case "busy": return { ...state, busy: { ...state.busy, [action.kind]: action.value } };
    case "error": return { ...state, error: action.message };
    case "accepted": return { ...state,
      requested: !state.requested || state.requested.sequence < action.command.sequence ? action.command : state.requested,
      acceptedIntent: Math.max(state.acceptedIntent, action.intent),
      failure: state.failure && state.failure.intent > action.intent ? state.failure : null };
    case "failed": {
      const next = action.failure, prior = state.failure;
      if (next.intent < state.acceptedIntent || (prior && !prior.refused && (next.refused || prior.intent > next.intent))) return state;
      return { ...state, failure: next };
    }
    case "acknowledge": {
      if (!state.failure || state.failure.refused || liveBlockReason(state.view, action.now, action.connected) ||
          !state.view?.observed.report || state.view.observed.report.sequence <= state.failure.sequence) return state;
      return { ...state, failure: null };
    }
  }
}
