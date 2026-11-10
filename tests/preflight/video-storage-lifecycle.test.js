import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const readJson = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const storage = readJson("infrastructure/boardwalk-s3/storage-template.json");
const previews = readJson("infrastructure/boardwalk-video-previews/template-v1.json");
const videoOriginalsPayload = readJson("infrastructure/boardwalk-s3/lifecycle/video-originals.json");
const archiveOriginalsPayload = readJson("infrastructure/boardwalk-s3/lifecycle/archive-originals.json");
const renditionsPayload = readJson("infrastructure/boardwalk-s3/lifecycle/renditions.json");
const renditionRules = previews.Resources.VideoRenditionBucket.Properties.LifecycleConfiguration.Rules;

// Compare the operator's S3 API payload with the owning CloudFormation rule shape.
function apiRule(rule) {
  let filter;
  if (rule.TagFilters) filter = { And: { Prefix: rule.Prefix, Tags: rule.TagFilters } };
  else if (rule.ObjectSizeGreaterThan !== undefined) filter = { ObjectSizeGreaterThan: Number(rule.ObjectSizeGreaterThan) };
  else filter = { Prefix: rule.Prefix ?? "" };
  return { ID: rule.Id, Status: rule.Status, Filter: filter,
    ...(rule.ExpirationInDays === undefined ? {} : { Expiration: { Days: rule.ExpirationInDays } }),
    ...(rule.ExpiredObjectDeleteMarker === undefined ? {} : { Expiration: { ExpiredObjectDeleteMarker: rule.ExpiredObjectDeleteMarker } }),
    ...(rule.NoncurrentVersionExpiration ? { NoncurrentVersionExpiration: rule.NoncurrentVersionExpiration } : {}),
    ...(rule.AbortIncompleteMultipartUpload ? { AbortIncompleteMultipartUpload: rule.AbortIncompleteMultipartUpload } : {}),
    ...(rule.Transitions ? { Transitions: rule.Transitions.map(({ TransitionInDays, StorageClass }) => ({ Days: TransitionInDays, StorageClass })) } : {}),
    ...(rule.NoncurrentVersionTransitions ? { NoncurrentVersionTransitions: rule.NoncurrentVersionTransitions.map(({ TransitionInDays, StorageClass }) => ({ NoncurrentDays: TransitionInDays, StorageClass })) } : {}),
  };
}

describe("video storage lifecycle", () => {
  it.each(["VideoOriginalsBucket", "ArchiveOriginalsBucket"])("transitions %s without deleting completed versions", (name) => {
    const bucket = storage.Resources[name];
    const lifecycle = bucket.Properties.LifecycleConfiguration;
    expect(lifecycle.TransitionDefaultMinimumObjectSize).toBe("all_storage_classes_128K");
    const expected = [
      { Id: "AbortIncompleteMultipartUploads", Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
      { Id: "TransitionOriginalsToIntelligentTiering", Status: "Enabled", ObjectSizeGreaterThan: "0",
        Transitions: [{ TransitionInDays: 0, StorageClass: "INTELLIGENT_TIERING" }],
        NoncurrentVersionTransitions: [{ TransitionInDays: 30, StorageClass: "INTELLIGENT_TIERING" }] },
    ];
    if (name === "VideoOriginalsBucket") expected.push({
      Id: "ArchiveRetentionBatch20261105A", Status: "Enabled", Prefix: "objects/",
      TagFilters: [{ Key: "ops-retention-batch", Value: "2026-11-05-a" }],
      Transitions: [{ TransitionInDays: 21, StorageClass: "DEEP_ARCHIVE" }],
    });
    expect(lifecycle.Rules).toEqual(expected);
    const payload = name === "VideoOriginalsBucket" ? videoOriginalsPayload : archiveOriginalsPayload;
    expect(payload).toEqual({ Rules: lifecycle.Rules.map(apiRule) });
    expect(bucket.DeletionPolicy).toBe("Retain");
    expect(bucket.UpdateReplacePolicy).toBe("Retain");
    expect(bucket.Properties).not.toHaveProperty("IntelligentTieringConfigurations");
    expect(bucket.Properties.VersioningConfiguration.Status).toBe("Enabled");
    expect(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm).toBe("AES256");
    expect(Object.values(bucket.Properties.PublicAccessBlockConfiguration)).toEqual([true, true, true, true]);
  });

  it("preserves working-file retention", () => {
    expect(storage.Resources.ArchiveWorkingBucket.Properties.LifecycleConfiguration.Rules).toEqual([
      { Id: "AbortIncompleteMultipartUploads", Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
    ]);
  });

  it("keeps staging for the whole bounded workflow plus a day, then removes noncurrent copies", () => {
    const staging = renditionRules.find((rule) => rule.Id === "ExpireStagingVersions");
    expect(staging).toEqual({ Id: "ExpireStagingVersions", Prefix: "staging/", Status: "Enabled",
      ExpirationInDays: 3, NoncurrentVersionExpiration: { NoncurrentDays: 1 } });
    expect(previews.Resources.PreviewWorkflow.Properties.Definition.TimeoutSeconds).toBeLessThanOrEqual((staging.ExpirationInDays - 1) * 86400);
    expect(renditionRules.find((rule) => rule.Id === "RemoveExpiredStagingDeleteMarkers")).toEqual({
      Id: "RemoveExpiredStagingDeleteMarkers", Prefix: "staging/", Status: "Enabled", ExpiredObjectDeleteMarker: true,
    });
  });

  it("preserves the five live rules in the step-1 payload and records the separate transcript drift", () => {
    // Existing source-only tagged deletion is deliberately outside this step's AWS PUT.
    const stepOne = renditionRules.filter((rule) => rule.Id !== "ExpireNoncurrentTranscriptResults");
    expect(stepOne.map((rule) => rule.Id)).toEqual([
      "ExpireStagingVersions", "RemoveExpiredStagingDeleteMarkers", "AbortIncompleteRenditionUploads", "ExpireClips", "ExpireTranscriptInputs",
    ]);
    expect(renditionsPayload).toEqual({ Rules: stepOne.map(apiRule) });
    expect(renditionRules).toHaveLength(6);
    for (const id of ["ExpireClips", "ExpireTranscriptInputs"]) {
      expect(stepOne.find((rule) => rule.Id === id)).toMatchObject({
        ExpirationInDays: 7, NoncurrentVersionExpiration: { NoncurrentDays: 7 },
      });
    }
    expect(stepOne.find((rule) => rule.Id === "AbortIncompleteRenditionUploads")).toEqual({
      Id: "AbortIncompleteRenditionUploads", Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    });
    expect(renditionRules.filter((rule) => rule.Prefix?.startsWith("outputs/")).map((rule) => rule.Prefix)).toEqual(["outputs/clips/"]);
  });

  const runbook = readFileSync(new URL("./fixtures/commands/video-lifecycle.md", import.meta.url), "utf8");
  const operatorScript = runbook.match(/```bash\n([\s\S]*?)\n```/)[1];
  function simulateOperator(blockedBucket = "no-bucket-matches") {
    // Shadow every AWS invocation: this only executes the documented shell control flow.
    const fakeAws = String.raw`
      aws() {
        case "$*" in
          *list-bucket-intelligent-tiering-configurations*)
            if [[ "$*" == *"$BLOCKED_BUCKET"* ]]; then printf '1\n'; else printf '0\n'; fi ;;
          *put-bucket-lifecycle-configuration*) printf 'PUT\n' ;;
          *get-bucket-lifecycle-configuration*) printf 'GET\n' ;;
          *) return 98 ;;
        esac
      }
    `;
    return spawnSync("bash", ["-c", `${fakeAws}\n${operatorScript}`], {
      env: { ...process.env, BLOCKED_BUCKET: blockedBucket }, encoding: "utf8",
    });
  }

  it.each(["njpbs-video-originals", "njpbs-archive-originals"])("refuses all lifecycle writes if %s has an opt-in configuration", (bucket) => {
    const result = simulateOperator(bucket);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("PUT");
    expect(result.stderr).toContain("before any lifecycle write");
  });

  it("allows the three documented payloads and read-backs only after both configuration checks pass", () => {
    const result = simulateOperator();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PUT\nGET\nPUT\nGET\nPUT\nGET\n");
  });
});
