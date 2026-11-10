import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePairReference } from "../../packages/content-core/src/public-release";
import type { RoutingMirrorStore } from "./public-release-routing-mirror-codec";
import type { syncPublicReleaseRoutingMirrors } from "./public-release-routing-mirrors";
export type MirrorRequestReference = {requestId:string;requestDigest:string;withdrawal:boolean};
export type MirrorJobResult = {state:"pending";requestId:string}|{state:"done";requestId:string;receipt:unknown};
export function preparePublicReleaseRoutingMirrorOutboxInTransaction(input:{firestore:Firestore;transaction:Transaction;
 operationId:string;minimumSequence:number;entryDigest:string;pairRefs:PublicReleasePairReference[];
 environment:"development"|"production";withdrawal:boolean}):Promise<Readonly<(()=>MirrorRequestReference)&MirrorRequestReference>>;
export type MirrorDrainInput={firestore:Firestore;store:RoutingMirrorStore;requestId:string;fallbackPaths?:string[];
 now?:()=>number;signal?:AbortSignal;sync:typeof syncPublicReleaseRoutingMirrors};
export function drainPublicReleaseRoutingMirrorOutbox(input:MirrorDrainInput):Promise<MirrorJobResult>;
export function flushPublicReleaseRoutingMirrorWithdrawal(input:MirrorDrainInput&{budgetMs?:number}):Promise<MirrorJobResult>;
export function drainDuePublicReleaseRoutingMirrorOutbox(input:Omit<MirrorDrainInput,"requestId">&{
 environment:"development"|"production";limit?:number}):Promise<{results:MirrorJobResult[];fullBatch:boolean}>;
