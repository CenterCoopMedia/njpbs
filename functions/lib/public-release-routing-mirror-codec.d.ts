import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewLocator } from "./public-release-serving";
export type RoutingMirrorBody = {locator:PairViewLocator;artifactPath:string;bodyDigest:string;bytes:number;mime:string;
  source:{family:string;id:string;operationId:string;sourceVersion:number;snapshotDigest:string}|null;verifiedSequence:number;validUntil:number};
export type RoutingNamespace = {schemaVersion:2;pairDigest:string;revision:number;validUntil:number;sourceDigest:string;
 routes:{path:string;state:"fallback"|"gone"|"redirect";canonicalPath:string;body:RoutingMirrorBody|null}[]};

export function parseNamespace(value:unknown,pair:PublicReleasePair,now?:number):RoutingNamespace;
export type RoutingMirrorStore={get(key:string):Promise<{size:number;body:ReadableStream<Uint8Array>;customMetadata?:Record<string,string>;etag?:string}|null>;
 put(key:string,bytes:Uint8Array,options:{onlyIf:{etagMatches:string}|{etagDoesNotMatch:"*"};customMetadata:Record<string,string>}):Promise<{etag?:string}|null>};
export type RoutingCodeIndex={schemaVersion:1;pairDigest:string;codeAssetManifestDigest:string;view:PairViewLocator;
 members:import("../../site/scripts/public-release-pair-code-pack").PairCodePackMember[]};
export class RoutingMirrorError extends Error{code:string;constructor(code?:string)}
export function same(a:unknown,b:unknown):boolean;
export function hash(bytes:Uint8Array):string;
export function prefix(pair:PublicReleasePair):string;
export function routePath(path:unknown):path is string;
export function locator(value:unknown,pair:PublicReleasePair):PairViewLocator;
export function parseCodeIndex(value:unknown,pair:PublicReleasePair):RoutingCodeIndex;
export function readJson(store:RoutingMirrorStore,key:string,limit?:number):Promise<any>;
export function existingJson(store:RoutingMirrorStore,key:string,limit?:number):Promise<{etag:string;value:any}|null>;
export function writeJson(store:RoutingMirrorStore,key:string,value:unknown,prior:{etag:string;value:any}|null,immutable?:boolean):Promise<{etag:string;value:any}>;
