import type { Firestore } from "firebase-admin/firestore";
import type { SelectorReceipt } from "../../packages/content-core/src/public-release-routing";
export function readPrivateRoutingMeasurementSelector(input: { firestore: Firestore; measurementId: string; now?: () => number }): Promise<SelectorReceipt>;
export function createPrivateRoutingMeasurementSelector(input: {firestore:Firestore;measurementId:string;expectedSourceDigest:string;dryRun?:boolean}): Promise<{
  dryRun:boolean;idempotent:boolean;measurementId:string;receipt:unknown}>;
