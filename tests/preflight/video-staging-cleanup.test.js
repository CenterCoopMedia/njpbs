import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = JSON.parse(readFileSync(new URL("../../infrastructure/boardwalk-video-previews/template-v1.json", import.meta.url), "utf8"));
const states = template.Resources.PreviewWorkflow.Properties.Definition.States;
const verify = states["Verify output versions"];
const cleanup = states["Delete verified staging copy"];

describe("verified video staging cleanup", () => {
  it("deletes the completed staging version only after verification succeeds", () => {
    expect(verify.Parameters.Payload.operation).toBe("verify");
    expect(verify.Next).toBe("Delete verified staging copy");
    expect(verify.ResultPath).toBe("$.verification");
    expect(verify).not.toHaveProperty("OutputPath");
    expect(cleanup.Resource).toBe("arn:aws:states:::aws-sdk:s3:deleteObject");
    expect(cleanup.Parameters).toEqual({
      Bucket: { Ref: "RenditionBucketName" }, "Key.$": "$.stagingKey",
      "VersionId.$": "$.staging.VersionId", ExpectedBucketOwner: { Ref: "AWS::AccountId" },
    });
    expect(states["Complete staging copy"].ResultPath).toBe("$.staging");
    expect(states["Start staging copy"].Parameters["Key.$"]).toBe("$.stagingKey");
    expect(cleanup.ResultPath).toBe("$.stagingCleanup");
    expect(cleanup.ResultPath).not.toBe("$.verification");
    expect(cleanup.ResultPath).not.toBe("$.staging");
    expect(cleanup.Next).toBe("Return verified outputs");
    expect(states[cleanup.Next]).toEqual({ Type: "Pass", OutputPath: "$.verification.Payload", End: true });
  });

  it("keeps staging when inspect, conversion or output verification fails", () => {
    for (const name of ["Inspect video", "Create viewing copy", "Verify output versions"]) {
      // An unhandled Task failure stops the execution before the success-only Next edge.
      expect(states[name]).not.toHaveProperty("Catch");
    }
    const incoming = Object.entries(states).filter(([, state]) => state.Next === "Delete verified staging copy");
    expect(incoming.map(([name]) => name)).toEqual(["Verify output versions"]);
    expect(states["Create viewing copy"].Next).toBe("Verify output versions");
  });

  it("retries the same idempotent version deletion without verifying deleted input again", () => {
    // S3 version DELETE succeeds even if that version was already removed after a lost response.
    expect(cleanup.Retry).toEqual([{
      ErrorEquals: ["States.TaskFailed", "States.Timeout"], IntervalSeconds: 2,
      MaxAttempts: 5, BackoffRate: 2, MaxDelaySeconds: 30, JitterStrategy: "FULL",
    }]);
    expect(cleanup.TimeoutSeconds).toBe(60);
    expect(states[cleanup.Next].End).toBe(true);
    expect(cleanup.Parameters["VersionId.$"]).toBe("$.staging.VersionId");
  });

  it("returns the paid verified result if cleanup exhausts its retries", () => {
    expect(cleanup.Catch).toEqual([{
      ErrorEquals: ["States.ALL"], ResultPath: "$.stagingCleanupError", Next: "Return verified outputs",
    }]);
    expect(states[cleanup.Catch[0].Next]).toEqual({
      Type: "Pass", OutputPath: "$.verification.Payload", End: true,
    });
  });

  it("grants permanent version deletion only for rendition staging", () => {
    const statements = template.Resources.PreviewWorkflowRole.Properties.Policies.flatMap((policy) => policy.PolicyDocument.Statement);
    const deletions = statements.filter((statement) => [].concat(statement.Action).some((action) => action?.startsWith("s3:Delete")));
    expect(deletions).toEqual([{ Effect: "Allow", Action: "s3:DeleteObjectVersion",
      Resource: { "Fn::Sub": "arn:${AWS::Partition}:s3:::${RenditionBucketName}/staging/*" } }]);
    // Original-range extraction bypasses staging and retains its separate result shape.
    expect(states["Verify original range"]["Fn::If"][1].End).toBe(true);
    expect(states["Verify original range"]["Fn::If"][1].OutputPath).toBe("$.Payload");
  });
});
