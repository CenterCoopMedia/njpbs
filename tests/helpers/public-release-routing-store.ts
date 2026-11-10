export function routingStore() {
  const objects = new Map<string,{bytes:Uint8Array;metadata:Record<string,string>;etag:string}>(); let revision=0;
  return { objects,
    async get(key:string) { const row=objects.get(key); return row ? {size:row.bytes.length,customMetadata:row.metadata,etag:row.etag,
      body:new Blob([new Uint8Array(row.bytes)]).stream()} : null; },
    async put(key:string,bytes:Uint8Array,options:any) { const row=objects.get(key);
      if (options.onlyIf.etagDoesNotMatch === "*" && row || options.onlyIf.etagMatches && row?.etag!==options.onlyIf.etagMatches) return null;
      const etag=String(++revision);objects.set(key,{bytes:new Uint8Array(bytes),metadata:options.customMetadata ?? {},etag});return {etag}; },
  };
}
