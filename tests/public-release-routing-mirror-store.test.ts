import {expect,it,vi,afterEach}from "vitest";
import storage from "../functions/lib/public-release-routing-mirror-store.js";
import codec from "../functions/lib/public-release-routing-mirror-codec.js";
import {routingStore}from "./helpers/public-release-routing-store";
const key="public-release-routing/development/committed-v2.json";
afterEach(()=>vi.unstubAllEnvs());
it("keeps the conditional ETag bound to the bytes of exactly one GET",async()=>{
 const store=routingStore();await codec.writeJson(store,key,{schemaVersion:1,value:"first"},null);
 const get=vi.spyOn(store,"get");const prior=await codec.existingJson(store,key);
 expect(get).toHaveBeenCalledTimes(1);expect(prior?.value.value).toBe("first");
 await codec.writeJson(store,key,{schemaVersion:1,value:"second"},prior);
 await expect(codec.writeJson(store,key,{schemaVersion:1,value:"stale"},prior)).rejects.toThrow();
});
it("uses the canonical dev bucket, exact metadata and provider conditional writes",async()=>{
 const send=vi.fn(async(command:any)=>{expect(command.input).toMatchObject({Bucket:"njpbs-dev-cms-publication",Key:key,IfNoneMatch:"*",CacheControl:"private, no-store",Metadata:{schemaversion:"2"}});return{ETag:'"one"'};});
 const store=storage.createPublicReleaseRoutingMirrorStore({environment:"development",accountId:"a".repeat(32),client:{send}as any});
 expect(await store.put(key,new Uint8Array([1]),{onlyIf:{etagDoesNotMatch:"*"},customMetadata:{schemaversion:"2"}})).toEqual({etag:'"one"'});
 for(const forbidden of ["release-pairs/owned/objects/abc","release-pair-inputs/v2/owned/manifests/abc.json","public-release-routing/production/committed-v2.json","public-release-routing/development/../escape"])
  await expect(store.put(forbidden,new Uint8Array([1]),{onlyIf:{etagDoesNotMatch:"*"},customMetadata:{}})).rejects.toThrow();
 expect(send).toHaveBeenCalledTimes(1);
});
it("sanitizes storage failures, treats conflicts as uncommitted and refuses real writes under emulator authority",async()=>{
 const send=vi.fn(async()=>{throw{$metadata:{httpStatusCode:412},message:"provider detail"};});
 const store=storage.createPublicReleaseRoutingMirrorStore({environment:"development",accountId:"a".repeat(32),client:{send}as any});
 expect(await store.put(key,new Uint8Array([1]),{onlyIf:{etagDoesNotMatch:"*"},customMetadata:{}})).toBeNull();
 send.mockRejectedValueOnce(new Error("provider detail"));await expect(store.get(key)).rejects.toThrow("mirror-unavailable");
 vi.stubEnv("FIRESTORE_EMULATOR_HOST","127.0.0.1:18181");
 await expect(store.put(key,new Uint8Array([1]),{onlyIf:{etagDoesNotMatch:"*"},customMetadata:{}})).rejects.toThrow("mirror-unavailable");expect(send).toHaveBeenCalledTimes(2);
});
