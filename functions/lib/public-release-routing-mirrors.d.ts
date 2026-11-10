import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { RoutingCodeIndex, RoutingMirrorStore } from "./public-release-routing-mirror-codec";
export const ROUTING_MIRROR_LEASE_MS:300000;
export const ROUTING_MIRROR_RENEW_AFTER_MS:30000;
export type MirrorSyncInput={firestore:Firestore;store:RoutingMirrorStore;pairs:PublicReleasePair[];operationId:string;
 minimumSequence:number;fallbackPaths?:string[];dryRun?:boolean;now?:()=>number;signal?:AbortSignal};
export function syncPublicReleaseRoutingMirrors(input:MirrorSyncInput):Promise<{schemaVersion:1;dryRun:boolean;operationId:string;
 sequence:number;authorityDigest:string;pairs:{pairDigest:string;revision:number;pendingContent:string[];namespaceDigest:string;tombstonePaths:string[]}[]}>;
export function seedPublicReleaseRoutingCodeAssets(input:{store:RoutingMirrorStore;pair:PublicReleasePair;index:RoutingCodeIndex;dryRun?:boolean;signal?:AbortSignal}):Promise<{dryRun:boolean;pairDigest:string;indexDigest:string}>;
export function renewPublicReleaseRoutingMirrorLeases(input:Pick<MirrorSyncInput,"firestore"|"store"|"pairs"|"now"|"signal">):Promise<{
 state:"pending"|"renewed";pairs?:{pairDigest:string;sequence:number}[]}>;
export function collectPublicReleaseRoutingMirrors(input:{firestore:Firestore;pairs:PublicReleasePair[];indexes:Array<RoutingCodeIndex|null>;
 priorNamespaces:Array<import("./public-release-routing-mirror-codec").RoutingNamespace|null>;fallbackPaths?:string[];minimumSequence?:number;signal?:AbortSignal}):Promise<unknown>;
