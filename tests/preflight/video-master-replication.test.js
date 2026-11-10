import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (name) => JSON.parse(readFileSync(new URL(`../../infrastructure/boardwalk-s3/${name}`, import.meta.url), "utf8"));
const source = readJson("storage-template.json");
const replica = readJson("replica-template.json");
const pairs = [["VideoOriginalsBucket", "VideoOriginalsReplicaBucket", "video"],
  ["ArchiveOriginalsBucket", "ArchiveOriginalsReplicaBucket", "archive"]];
const account = "123456789012";
const render = (value) => value["Fn::Sub"].replaceAll("${AWS::Partition}", "aws").replaceAll("${AWS::AccountId}", account);

describe("regional video master replicas", () => {
  it.each(pairs)("copies every %s key to its own Deep Archive namespace without copying deletion", (name, destination, kind) => {
    const config = source.Resources[name].Properties.ReplicationConfiguration;
    expect(config.Role).toEqual({ "Fn::GetAtt": ["MasterReplicationRole", "Arn"] });
    expect(config.Rules).toEqual([{
      Id: "CopyMastersToDeepArchive", Priority: 1, Status: "Enabled", Filter: { Prefix: "" },
      DeleteMarkerReplication: { Status: "Disabled" }, Destination: {
        Bucket: { "Fn::Sub": `arn:\${AWS::Partition}:s3:::njpbs-${kind}-originals-replica-\${AWS::AccountId}-\${MasterReplicaRegion}` },
        StorageClass: "DEEP_ARCHIVE",
      },
    }]);
    expect(replica.Resources[destination].Properties.BucketName).toEqual({
      "Fn::Sub": `njpbs-${kind}-originals-replica-\${AWS::AccountId}-\${AWS::Region}`,
    });
    expect(config.Rules[0]).not.toHaveProperty("ExistingObjectReplication");
    expect(config.Rules[0].Destination).not.toHaveProperty("ReplicationTime");
    expect(config.Rules[0].Destination).not.toHaveProperty("Metrics");
    expect(source.Resources[name].Properties.LifecycleConfiguration.Rules).toContainEqual({
      Id: "TransitionOriginalsToIntelligentTiering", Status: "Enabled", ObjectSizeGreaterThan: "0",
      Transitions: [{ TransitionInDays: 0, StorageClass: "INTELLIGENT_TIERING" }],
      NoncurrentVersionTransitions: [{ TransitionInDays: 30, StorageClass: "INTELLIGENT_TIERING" }],
    });
  });

  it("constrains the replica region and keeps working files outside replication", () => {
    expect(source.Parameters.MasterReplicaRegion).toMatchObject({ Default: "us-west-2", AllowedValues: ["us-west-2"] });
    expect(source.Resources.ArchiveWorkingBucket.Properties).not.toHaveProperty("ReplicationConfiguration");
    const names = pairs.map(([, name]) => replica.Resources[name].Properties.BucketName["Fn::Sub"]);
    expect(new Set(names).size).toBe(2);
    expect(Object.values(replica.Resources).filter((resource) => resource.Type === "AWS::S3::Bucket")).toHaveLength(2);
  });

  it.each([["VideoOriginalsBucket", "njpbs-video-originals/"], ["ArchiveOriginalsBucket", "njpbs-archive-originals/"],
    ["ArchiveWorkingBucket", "njpbs-archive-working/"]])("records existing source access logging for %s", (name, prefix) => {
    expect(source.Resources[name].Properties.LoggingConfiguration).toEqual({
      DestinationBucketName: { "Fn::Sub": "njpbs-s3-access-logs-${AWS::AccountId}-${AWS::Region}" },
      LogFilePrefix: prefix, TargetObjectKeyFormat: { PartitionedPrefix: { PartitionDateSource: "EventTime" } },
    });
  });

  it.each(pairs)("retains %s replicas and their access protections", (_source, name) => {
    const bucket = replica.Resources[name];
    expect(bucket.DeletionPolicy).toBe("Retain");
    expect(bucket.UpdateReplacePolicy).toBe("Retain");
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(bucket.Properties.OwnershipControls.Rules).toEqual([{ ObjectOwnership: "BucketOwnerEnforced" }]);
    expect(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault).toEqual({ SSEAlgorithm: "AES256" });
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.LifecycleConfiguration.Rules).toEqual([{
      Id: "AbortIncompleteReplicaUploads", Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    }]);
    expect(bucket.Properties).not.toHaveProperty("CorsConfiguration");
    expect(bucket.Properties).not.toHaveProperty("ObjectLockEnabled");
    expect(bucket.Properties).not.toHaveProperty("LoggingConfiguration");
    const policy = replica.Resources[`${name}Policy`];
    expect(policy.DeletionPolicy).toBe("Retain");
    expect(policy.UpdateReplacePolicy).toBe("Retain");
    expect(policy.Properties.PolicyDocument.Statement).toContainEqual(expect.objectContaining({
      Sid: "DenyInsecureTransport", Effect: "Deny", Principal: "*", Action: "s3:*",
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    }));
  });

  it.each(pairs)("denies CMS/media access to %s while preserving the separate replication and operator path", (_source, name) => {
    const deny = replica.Resources[`${name}Policy`].Properties.PolicyDocument.Statement.find((s) => s.Sid === "DenyCMSAndMediaRoles");
    expect(deny).toMatchObject({ Effect: "Deny", Principal: "*", Action: "s3:*" });
    expect(deny.Resource).toHaveLength(2);
    const patterns = deny.Condition.ArnLike["aws:PrincipalArn"].map(render);
    const matches = (arn) => patterns.some((pattern) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(arn));
    for (const role of ["njpbs-boardwalk-video-read", "njpbs-boardwalk-archive-read", "njpbs-boardwalk-transcript-data",
      "njpbs-boardwalk-transcription-byok-data", "njpbs-boardwalk-video-previews-PreviewWorkflowRole-fixture", "njpbs-mediaconvert-video-preview"]) {
      expect(matches(`arn:aws:iam::${account}:role/${role}`)).toBe(true);
    }
    for (const role of ["njpbs-storage-MasterReplicationRole-fixture", "njpbs-storage-MasterBatchReplicationRole-fixture", "operator-recovery"]) {
      expect(matches(`arn:aws:iam::${account}:role/${role}`)).toBe(false);
    }
  });

  it("gives the S3 role only scoped source reads and replica writes", () => {
    const role = source.Resources.MasterReplicationRole.Properties;
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sts:AssumeRole",
      Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
        ArnEquals: { "aws:SourceArn": pairs.map(([, , kind]) => ({
          "Fn::Sub": `arn:\${AWS::Partition}:s3:::njpbs-${kind}-originals-\${AWS::AccountId}-\${AWS::Region}`,
        })) } },
    }]);
    const statements = role.Policies.flatMap((p) => p.PolicyDocument.Statement);
    expect(statements.map((s) => s.Action)).toEqual([
      ["s3:GetReplicationConfiguration", "s3:ListBucket"],
      ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], "s3:ReplicateObject",
    ]);
    expect(statements.at(-1).Resource).toEqual(pairs.map(([, , kind]) => ({
      "Fn::Sub": `arn:\${AWS::Partition}:s3:::njpbs-${kind}-originals-replica-\${AWS::AccountId}-\${MasterReplicaRegion}/*`,
    })));
    expect(statements.every((s) => s.Effect === "Allow" && s.Resource !== "*")).toBe(true);
  });

  it("separates Batch initiation from the data-copy role and scopes its control artifacts", () => {
    const role = source.Resources.MasterBatchReplicationRole.Properties;
    expect(role.AssumeRolePolicyDocument.Statement[0]).toMatchObject({
      Principal: { Service: "batchoperations.s3.amazonaws.com" },
      Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
        ArnLike: { "aws:SourceArn": { "Fn::Sub": "arn:${AWS::Partition}:s3:${AWS::Region}:${AWS::AccountId}:job/*" } } },
    });
    const statements = role.Policies.flatMap((p) => p.PolicyDocument.Statement);
    expect(statements.map((s) => s.Action)).toEqual(["s3:InitiateReplication", ["s3:GetObject", "s3:GetObjectVersion"], "s3:PutObject"]);
    expect(statements[1].Resource).toEqual({ "Fn::Sub": "arn:${AWS::Partition}:s3:::njpbs-video-renditions-${AWS::AccountId}-${AWS::Region}/replication/manifests/*" });
    expect(statements[2].Resource).toEqual({ "Fn::Sub": "arn:${AWS::Partition}:s3:::njpbs-video-renditions-${AWS::AccountId}-${AWS::Region}/replication/reports/*" });
  });
});
