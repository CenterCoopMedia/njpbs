import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import cleanup from "../../functions/lib/source-video-replacement-cleanup.js";
import renditions from "../../functions/lib/source-media-rendition.js";

let server, client, bytes, requests;
const asset = { id: "storage-fixture", sourceId: "video-library", objectKey: "shared/objects/storage-fixture.mp4", objectVersionId: "source-v1", sizeBytes: 32 };
const id = renditions.sourceMediaRenditionId(asset);
const publicMedia = { url: `https://media.njpbs.org/cms-media/video/${asset.id}/${"a".repeat(64)}.mp4`, posterUrl: `https://media.njpbs.org/cms-media/video/${asset.id}/${"a".repeat(64)}.jpg` };
const row = (id, value) => ({ id, data: () => value });
const config = { source: { bucket: "originals" }, renditionBucket: "derived", replicaBucket: "replica", renditionExpectedBucketOwner: "123456789012", cleanupRoleArn: "arn:aws:iam::123456789012:role/fixture", region: "us-east-2", replicaRegion: "us-west-2" };
const encode = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const put = (bucket, key, version) => bytes.set(`${bucket}/${key}?${version}`, Buffer.from("fixture bytes"));
beforeEach(async () => {
  bytes = new Map(); requests = [];
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost"), [, bucket, ...parts] = url.pathname.split("/");
    const key = parts.join("/"); requests.push({ method: request.method, bucket, key, version: url.searchParams.get("versionId"), prefix: url.searchParams.get("prefix"), keyMarker: url.searchParams.get("key-marker"), versionMarker: url.searchParams.get("version-id-marker") });
    if (request.method === "HEAD") {
      response.writeHead(200, { "x-amz-version-id": asset.objectVersionId, "x-amz-replication-status": "COMPLETED", "etag": '"fixture-etag"', "content-length": "32" }); response.end(); return;
    }
    if (request.method === "GET" && url.searchParams.has("versions")) {
      const prefix = url.searchParams.get("prefix");
      const marker = url.searchParams.has("key-marker") ? `${bucket}/${url.searchParams.get("key-marker")}?${url.searchParams.get("version-id-marker")}` : "";
      const inventory = [...bytes.keys()].filter(key => key.startsWith(`${bucket}/${prefix}`) && key > marker).sort();
      const page = inventory.slice(0, 1), truncated = inventory.length > page.length;
      const [nextKey, nextVersion] = (page.at(-1) ?? "").split("?");
      const markers = truncated ? `<NextKeyMarker>${encode(nextKey.slice(bucket.length + 1))}</NextKeyMarker><NextVersionIdMarker>${nextVersion}</NextVersionIdMarker>` : "";
      const versions = page.map(key => {
        const [path, version] = key.split("?");
        return `<Version><Key>${encode(path.slice(bucket.length + 1))}</Key><VersionId>${version}</VersionId><IsLatest>true</IsLatest><LastModified>2026-11-03T00:00:00Z</LastModified><ETag>fixture</ETag><Size>13</Size><StorageClass>STANDARD</StorageClass></Version>`;
      });
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(`<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>${truncated}</IsTruncated>${markers}${versions.join("")}</ListVersionsResult>`); return;
    }
    if (request.method === "DELETE") {
      const version = url.searchParams.get("versionId");
      if (version) bytes.delete(`${bucket}/${key}?${version}`);
      else for (const name of bytes.keys()) if (name.startsWith(`${bucket}/${key}?`)) bytes.delete(name);
      response.writeHead(204); response.end(); return;
    }
    response.writeHead(400); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  client = new S3Client({ endpoint: `http://127.0.0.1:${server.address().port}`, region: "us-east-2", forcePathStyle: true, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" } });
});
afterEach(async () => { client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

describe("permanent version deletion through the actual S3 SDK", () => {
  it("removes source, replica, every rendition/staging version, transcript audio and both R2 copies; retry is safe", async () => {
    put("originals", asset.objectKey, asset.objectVersionId); put("replica", asset.objectKey, asset.objectVersionId);
    put("originals", "shared/objects/current.mp4", "current"); put("replica", "shared/objects/current.mp4", "current");
    for (const prefix of [`outputs/${id}/`, `staging/${id}/`, "transcripts/results/transcript.", "transcripts/inputs/transcript/", "transcripts/inputs/amazon/transcript/", "transcripts/inputs/audio/preparation/"])
      for (const version of ["old", "new"]) put("derived", `${prefix}fixture`, version);
    put("derived", "outputs/current/preview.mp4", "current");
    for (const url of Object.values(publicMedia)) put("public", new URL(url).pathname.slice(1), "r2");
    put("private", "private-video/fixture/web.mp4", "r2"); put("private", "private-audio/fixture/input.m4a", "r2");
    let purged;
    const remove = cleanup.createVideoVersionStorage(config, { s3: client, replica: client, readSource: client,
      privateStorage: () => ({ client, bucket: "private" }), publicStorage: () => ({ client, bucket: "public" }), purge: async urls => { purged = urls; } });
    const version = { assetId: asset.id, binary: asset, publicMedia, related: {
      transcripts: [row("transcript", {})], preparations: [row("preparation", {})], privateCopies: [
        row("video-copy", { files: { web: { key: "private-video/fixture/web.mp4" } } }),
        row("audio-copy", { files: { audio: { key: "private-audio/fixture/input.m4a" } } }),
      ],
    } };
    await remove(version); await remove(version);
    expect([...bytes.keys()]).toEqual(["originals/shared/objects/current.mp4?current", "replica/shared/objects/current.mp4?current", "derived/outputs/current/preview.mp4?current"]);
    expect(purged).toEqual(Object.values(publicMedia));
    expect(requests.filter(row => row.method === "DELETE" && ["originals", "replica", "derived"].includes(row.bucket)).every(row => row.version)).toBe(true);
    expect(requests.some(row => row.bucket === "replica" && row.key === asset.objectKey && row.version === asset.objectVersionId)).toBe(true);
    expect(requests).toContainEqual(expect.objectContaining({ method: "GET", bucket: "derived", prefix: `outputs/${id}/`, keyMarker: `outputs/${id}/fixture`, versionMarker: "new" }));
  });
});
