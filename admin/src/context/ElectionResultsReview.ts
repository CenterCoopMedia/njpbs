import { createContext } from "react";
import type { ElectionRaceApproval } from "../../../packages/content-core/src/election-results";

export const ElectionResultsReview = createContext<readonly ElectionRaceApproval[]>([]);
