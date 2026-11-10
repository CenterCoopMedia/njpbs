import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = JSON.parse(readFileSync(new URL("../../infrastructure/boardwalk-video-previews/template-v1.json", import.meta.url), "utf8"));

describe("transcript result storage policy", () => {
  it("expires only confirmed superseded result versions after seven days", () => {
    const bucket = template.Resources.VideoRenditionBucket;
    const rules = bucket.Properties.LifecycleConfiguration.Rules;
    const resultRules = rules.filter((rule) => rule.Prefix === "transcripts/results/" && rule.Status === "Enabled");
    expect(resultRules).toHaveLength(1);
    expect(resultRules[0].NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 7 });
    expect(resultRules[0].TagFilters).toEqual([{ Key: "transcript-retention", Value: "superseded" }]);
    expect(resultRules[0]).not.toHaveProperty("ExpirationInDays");
    expect(resultRules[0]).not.toHaveProperty("ExpirationDate");
    expect(bucket.DeletionPolicy).toBe("Retain");
    expect(bucket.UpdateReplacePolicy).toBe("Retain");
  });

  it("allows exact version cleanup only for provisional edited results", () => {
    const statements = template.Resources.TranscriptControlRole.Properties.Policies
      .flatMap((policy) => policy.PolicyDocument.Statement);
    const deletion = statements.filter((statement) => [].concat(statement.Action).includes("s3:DeleteObjectVersion"));
    expect(deletion).toHaveLength(1);
    expect(deletion[0]).toMatchObject({ Effect: "Allow",
      Resource: { "Fn::Sub": "arn:${AWS::Partition}:s3:::${RenditionBucketName}/transcripts/results/*.edited.*" } });
    expect(statements.some((statement) => [].concat(statement.Action).includes("s3:DeleteObject"))).toBe(false);
  });
});
