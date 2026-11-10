import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { privateInstallCredential } from "../scripts/install-private-public-release.mjs";
import { cloudflarePrivatePairProvider, PrivateProviderNotSent } from "../scripts/lib/public-release-private-provider.mjs";
const name = "njpbs-pair-slot-aaaaaaaa-1111-4111-8111-111111111111";
it("creates a fresh empty Worker atomically private before the first versions upload",async()=>{
 const fetcher=vi.fn(async(url:string,options:RequestInit)=>{
  expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/workers`);expect(options.method).toBe("POST");
  expect(JSON.parse(options.body as string)).toEqual({name,subdomain:{enabled:false,previews_enabled:false},tags:[`private-pair:${"b".repeat(64)}`]});
  return Response.json({success:true,result:{id:"1".repeat(32)}});
 });
 const provider=cloudflarePrivatePairProvider({accountId:"a".repeat(32),credential:async()=>"fixture-authentication",fetcher});
 await provider.create(name,"b".repeat(64));expect(fetcher).toHaveBeenCalledTimes(1);
});
it("reads actual script bytes from the documented content/v2 endpoint", async () => {
  const source = "export default {fetch(){return new Response(null,{status:404})}}";
  const fetcher = vi.fn(async (url: string) => { expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/scripts/${name}/content/v2`);
    return new Response(source, { headers: { "content-type": "application/javascript" } }); });
  const provider = cloudflarePrivatePairProvider({ accountId: "a".repeat(32), credential: async () => "fixture-authentication", fetcher });
  expect(await provider.sourceDigest(name)).toBe(createHash("sha256").update(source).digest("hex"));
});
it("hashes the one actual module in a multipart content/v2 readback", async () => {
  const form = new FormData(); form.set("index.mjs", new Blob(["exact source"]), "index.mjs");
  const provider = cloudflarePrivatePairProvider({ accountId: "a".repeat(32), credential: async () => "fixture-authentication", fetcher: async () => new Response(form) });
  expect(await provider.sourceDigest(name)).toBe(createHash("sha256").update("exact source").digest("hex"));
});
it("consumes a pipe-backed credential once across the private provider session", async () => {
  const stream = Readable.from(["fixture-private-provider-authentication\n"]), iterator = vi.spyOn(stream, Symbol.asyncIterator);
  const credential = privateInstallCredential(stream);
  await credential(); await credential(); expect(iterator).toHaveBeenCalledTimes(1);
});
it("identifies only transport-confirmed pre-send cancellation and credential failures as not sent", async () => {
  const fetcher = vi.fn(), abort = new AbortController(); abort.abort();
  const provider = cloudflarePrivatePairProvider({ accountId: "a".repeat(32), credential: async () => "fixture-authentication", fetcher });
  await expect(provider.upload(name, {}, new Uint8Array([1]), abort.signal)).rejects.toBeInstanceOf(PrivateProviderNotSent);
  expect(fetcher).not.toHaveBeenCalled();
  const unknown = cloudflarePrivatePairProvider({ accountId: "a".repeat(32), credential: async () => "fixture-authentication", fetcher: async () => { throw new Error("Lost reply after send"); } });
  try { await unknown.upload(name, {}, new Uint8Array([1])); throw new Error("Expected refusal"); }
  catch (error) { expect(error).not.toBeInstanceOf(PrivateProviderNotSent); }
});

it("refuses real provider mutations when a throwaway emulator could own the durable ledger", async () => {
  const fetcher = vi.fn(); vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:18181");
  try {
    const provider = cloudflarePrivatePairProvider({ accountId: "a".repeat(32), credential: async () => "fixture-authentication", fetcher });
    await expect(provider.upload(name, {}, new Uint8Array([1]))).rejects.toBeInstanceOf(PrivateProviderNotSent);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});
