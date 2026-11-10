"use strict";

const { SFNClient, StartExecutionCommand, DescribeExecutionCommand } = require("@aws-sdk/client-sfn");
const { isDeepStrictEqual } = require("node:util");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const { renditionState } = require("./video-preview-job");
const { createOriginalStorage } = require("./source-originals");
const { assertOriginalReadable } = require("./source-original-state");
const { parseSourceMediaRendition } = require("./source-media-rendition");

function executionName(job) {
  return `${job.id.slice(0, 32)}-${job.attemptId}`;
}

function executionArn(stateMachineArn, job) {
  return `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${executionName(job)}`;
}

function workflowInput(job) {
  return { id: job.id, assetId: job.assetId, sourceId: job.sourceId,
    sourceObjectKey: job.sourceObjectKey, sourceObjectVersionId: job.sourceObjectVersionId,
    sourceSizeBytes: job.sourceSizeBytes, attemptId: job.attemptId };
}

function samePreviewExecution(job, execution, workflowArn) {
  if (execution?.executionArn !== executionArn(workflowArn, job) || execution.stateMachineArn !== workflowArn) return false;
  try { return isDeepStrictEqual(JSON.parse(execution.input), workflowInput(job)); } catch { return false; }
}

function createVideoPreviewProcessor(config, deps = {}) {
  const client = deps.client ?? new SFNClient({ region: config.region,
    credentials: createAwsRoleCredentialProvider({ roleArn: config.controlRoleArn,
      audience: config.audience, region: config.region }),
  });

  const originalStorage = deps.originalStorage ?? createOriginalStorage(config, { client: deps.s3 });

  return async function process(job, save) {
    const arn = executionArn(config.workflowArn, job);
    if (job.phase === "pending") {
      const head = await originalStorage.head(config.source, { objectKey: job.sourceObjectKey,
        objectVersionId: job.sourceObjectVersionId, sizeBytes: job.sourceSizeBytes });
      assertOriginalReadable(head);
      try {
        await client.send(new StartExecutionCommand({ stateMachineArn: config.workflowArn,
          name: executionName(job), input: JSON.stringify(workflowInput(job)),
        }));
      } catch (error) {
        // Standard execution names are retained for 90 days. A completed execution can
        // be found after a lost response, without submitting a second paid conversion.
        if (error?.name !== "ExecutionAlreadyExists") throw error;
      }
      await save({ phase: "running", executionArn: arn }, renditionState(job, "processing"));
      return;
    }
    if (job.phase !== "running" || job.executionArn !== arn) throw new Error("workflow_identity_invalid");
    const result = await client.send(new DescribeExecutionCommand({ executionArn: arn }));
    if (result.status === "RUNNING" || result.status === "PENDING_REDRIVE") return;
    if (result.status !== "SUCCEEDED") {
      await save({ phase: "failed", active: false }, renditionState(job, "failed", { errorCode: "conversion_failed" }));
      return;
    }
    const output = JSON.parse(result.output ?? "null");
    if (output?.id !== job.id || output.attemptId !== job.attemptId) throw new Error("workflow_output_invalid");
    const rendition = renditionState(job, "ready", { web: output.web, poster: output.poster });
    const asset = { id: job.assetId, sourceId: job.sourceId, objectKey: job.sourceObjectKey,
      objectVersionId: job.sourceObjectVersionId, sizeBytes: job.sourceSizeBytes };
    if (!parseSourceMediaRendition(rendition, asset)) throw new Error("rendition_output_invalid");
    await save({ phase: "ready", active: false }, rendition);
  };
}

module.exports = { executionName, executionArn, workflowInput, samePreviewExecution, createVideoPreviewProcessor };
