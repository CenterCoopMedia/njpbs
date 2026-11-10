import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewLocator, PairServingDecision } from "./public-release-serving";
export type PairReadStore = { get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array>; customMetadata?: Record<string,string> } | null> };
export function readBoundedPairObject(store: PairReadStore,key: string,limit: number,expected?: Record<string,string>,size?: number): Promise<Uint8Array>;
export function isPublicPairRequestPath(path: string): boolean;
export function readPublicReleasePairOutput(input: { store: PairReadStore; pair: PublicReleasePair; locator: PairViewLocator; path: string }): Promise<{
  path: string; bodyDigest: string; body: Uint8Array; bytes: number; status: 200|302|308|410; headers: Record<string,string>; objectKey: string;
} | null>;
export function verifyPairRouteTarget(input: {store: PairReadStore; pair: PublicReleasePair;
  decision: Pick<PairServingDecision,"locator"|"composition"|"route"|"contentHead"|"targetProof"|"path">;
  output:{path:string;bodyDigest:string;status:number}}): Promise<boolean>;
