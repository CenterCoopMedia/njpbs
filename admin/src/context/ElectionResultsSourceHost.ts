import { createContext } from "react";
import type { AdminBlock } from "../lib/block-factory";
import type { ElectionSourceApi } from "../lib/election-sources";

export interface ElectionSourceHost {
  api: ElectionSourceApi; collection: "cmsPages" | "cmsPosts"; documentId?: string; version?: number;
  publicBlocks?: readonly AdminBlock[]; canPublish: boolean; locked: boolean; pauseLocked?: boolean; hasUnsavedWork: () => boolean; onBusyChange?: (blockId: string, busy: boolean) => void;
}
export const ElectionResultsSourceHost = createContext<(ElectionSourceHost & { connectionStates: ReadonlyMap<string, boolean>; onConnectedChange: (blockId: string, active: boolean | undefined) => void }) | null>(null);
