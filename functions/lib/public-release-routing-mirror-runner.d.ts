import type { Firestore } from "firebase-admin/firestore";
import type { RoutingMirrorStore } from "./public-release-routing-mirror-codec";
export function createPublicReleaseRoutingMirrorRunner(input:{enabled?:boolean;firestore:Firestore;environment:"development"|"production";
 getStore:()=>Promise<RoutingMirrorStore>;now?:()=>number}):{tick(input?:{signal?:AbortSignal}):Promise<unknown>};
