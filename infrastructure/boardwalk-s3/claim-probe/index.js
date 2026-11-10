"use strict";

const functions = require("@google-cloud/functions-framework");
const { ListObjectsV2Command, S3Client } = require("@aws-sdk/client-s3");
const { GetCallerIdentityCommand, STSClient } = require("@aws-sdk/client-sts");
const { fromWebToken } = require("@aws-sdk/credential-providers");

const AUDIENCE = "njpbs-boardwalk-s3";
const EXPECTED_EMAIL = process.env.GOOGLE_RUNTIME_EMAIL ?? "REPLACE_ME@example.org";
const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const AWS_REGION = "us-east-2";
const AWS_ACCOUNT = process.env.AWS_ACCOUNT_ID ?? "";
const ROLE_TESTS = Object.freeze({
  video: {
    roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/njpbs-boardwalk-video-read`,
    allowedBucket: `njpbs-video-originals-${AWS_ACCOUNT}-${AWS_REGION}`,
    deniedBucket: `njpbs-archive-originals-${AWS_ACCOUNT}-${AWS_REGION}`,
  },
  archive: {
    roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/njpbs-boardwalk-archive-read`,
    allowedBucket: `njpbs-archive-originals-${AWS_ACCOUNT}-${AWS_REGION}`,
    deniedBucket: `njpbs-video-originals-${AWS_ACCOUNT}-${AWS_REGION}`,
  },
});

async function testAwsRole(token, roleTest) {
  const credentials = await fromWebToken({
    roleArn: roleTest.roleArn,
    roleSessionName: "boardwalk-identity-probe",
    webIdentityToken: token,
    clientConfig: { region: AWS_REGION },
  })();
  const sts = new STSClient({ region: AWS_REGION, credentials });
  const caller = await sts.send(new GetCallerIdentityCommand({}));
  const s3 = new S3Client({ region: AWS_REGION, credentials });
  const allowed = await s3.send(new ListObjectsV2Command({
    Bucket: roleTest.allowedBucket,
    ExpectedBucketOwner: AWS_ACCOUNT,
    MaxKeys: 1,
  }));
  let denied = false;
  try {
    await s3.send(new ListObjectsV2Command({
      Bucket: roleTest.deniedBucket,
      ExpectedBucketOwner: AWS_ACCOUNT,
      MaxKeys: 1,
    }));
  } catch (error) {
    denied = error?.name === "AccessDenied" || error?.$metadata?.httpStatusCode === 403;
  }
  if (!denied) {
    throw new Error("Cross-source bucket request was not denied");
  }
  return {
    roleArn: roleTest.roleArn,
    callerAccount: caller.Account,
    callerArn: caller.Arn,
    allowedListBucket: roleTest.allowedBucket,
    allowedObjectCount: allowed.Contents?.length ?? 0,
    deniedListBucket: roleTest.deniedBucket,
  };
}

functions.http("inspectBoardwalkClaims", async (request, response) => {
  response.set("Cache-Control", "private, no-store");
  try {
    const url = new URL(METADATA_URL);
    url.searchParams.set("audience", AUDIENCE);
    url.searchParams.set("format", "full");
    const metadataResponse = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!metadataResponse.ok) {
      throw new Error("Metadata identity request failed");
    }
    const token = await metadataResponse.text();
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Metadata identity response was not a JWT");
    }
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.aud !== AUDIENCE || claims.email !== EXPECTED_EMAIL) {
      throw new Error("Runtime identity claims did not match");
    }
    const inspection = {
      iss: claims.iss,
      aud: claims.aud,
      azp: claims.azp,
      sub: claims.sub,
      email: claims.email,
      email_verified: claims.email_verified,
    };
    const roleTest = ROLE_TESTS[request.body?.role];
    if (roleTest) inspection.aws = await testAwsRole(token, roleTest);
    response.status(200).json(inspection);
  } catch (_error) {
    response.status(500).json({ error: "Claim inspection failed" });
  }
});
