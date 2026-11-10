import type { S3Client } from "@aws-sdk/client-s3";
import type { RoutingMirrorStore } from "./public-release-routing-mirror-codec";
export function createPublicReleaseRoutingMirrorStore(input:{environment:"development"|"production";accountId:string;
 credential?:()=>Promise<{accessKeyId:string;secretAccessKey:string}>;client?:Pick<S3Client,"send">}):RoutingMirrorStore&{close():void};
