import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand, HeadObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import uploaderModule from "../../functions/lib/s3-media-upload.js";

const source = { bucket: "private-video", expectedBucketOwner: "123456789012",
  roleArn: "arn:aws:iam::123456789012:role/video" };

function fixture(bytes, expectedHash = createHash("sha256").update(bytes).digest("hex")) {
  const commands = [];
  class FakeS3Client {
    async send(command) {
      commands.push(command);
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
      if (command instanceof UploadPartCommand) return { ETag: `part-${command.input.PartNumber}` };
      if (command instanceof CompleteMultipartUploadCommand) return { VersionId: "version-1" };
      if (command instanceof HeadObjectCommand) return { VersionId: "version-1", ContentLength: bytes.length };
      if (command instanceof AbortMultipartUploadCommand) return {};
      throw new Error("Unexpected command");
    }
  }
  const uploader = uploaderModule.createS3MediaUploader({ region: "us-east-2", audience: "test" }, {
    S3ClientCtor: FakeS3Client,
    createAwsRoleCredentialProviderFn: () => async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
  });
  const session = { id: "submission", assetId: "submission", objectKey: "objects/submission.mp4",
    mimeType: "video/mp4", sizeBytes: bytes.length, contentHash: expectedHash };
  const body = (async function* () {
    yield bytes.subarray(0, 6 * 1024 * 1024);
    yield bytes.subarray(6 * 1024 * 1024);
  })();
  return { uploader, session, body, commands };
}

describe("UGC video import stream", () => {
  it("uploads bounded checksummed parts and heads the completed object", async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
    const { uploader, session, body, commands } = fixture(bytes);
    const result = await uploader.importStream(source, session, body);
    expect(result.VersionId).toBe("version-1");
    const parts = commands.filter(command => command instanceof UploadPartCommand);
    expect(parts.map(command => command.input.ContentLength)).toEqual([8 * 1024 * 1024, 1024 * 1024]);
    expect(parts.every(command => command.input.ChecksumSHA256 ===
      createHash("sha256").update(command.input.Body).digest("base64"))).toBe(true);
    expect(commands.some(command => command instanceof CompleteMultipartUploadCommand)).toBe(true);
  });

  it("aborts before completion when quarantine bytes change", async () => {
    const bytes = Buffer.from("changed");
    const { uploader, session, body, commands } = fixture(bytes, "0".repeat(64));
    await expect(uploader.importStream(source, session, body)).rejects.toThrow("Import hash changed");
    expect(commands.some(command => command instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(commands.some(command => command instanceof CompleteMultipartUploadCommand)).toBe(false);
  });
});
