import { parseReaderSeals } from "./public-release-pair-reader-contract";
import { trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "./public-release-pair-qualification";

/** The switch consumes the existing reader grammar unchanged and passes the
 * same tracked SDK transaction used by both actual qualification guards. */
export const publicReleaseSwitchQualificationReadOwner = Object.freeze({
  trackQualificationTransactionReads,
  assertQualificationTransactionReadBudget,
  parseReaderSeals,
});
