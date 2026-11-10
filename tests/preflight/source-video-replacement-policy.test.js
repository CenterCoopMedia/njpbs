import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("can delete exact versions of imported originals anywhere in both source buckets", () => {
  const template = JSON.parse(readFileSync(new URL("../../infrastructure/boardwalk-video-replacement/template-v1.json", import.meta.url), "utf8"));
  const statements = template.Resources.VideoReplacementCleanupRole.Properties.Policies[0].PolicyDocument.Statement;
  const originals = statements.find(row => row.Sid === "ExactOriginalVersions");
  expect(originals.Action).toEqual(["s3:DeleteObjectVersion"]);
  // The importer accepts keys outside objects/, including these historical paths.
  for (const bucket of ["OriginalVideoBucketName", "ReplicaVideoBucketName"]) {
    const resource = originals.Resource.map(row => row["Fn::Sub"]).find(arn => arn.includes(`\${${bucket}}/`));
    for (const key of ["objects/video.mp4", "external/master.mxf", "shared/legacy/meeting.mov"]) {
      const prefix = resource.split(`\${${bucket}}/`)[1];
      expect(key).toMatch(new RegExp("^" + prefix.replaceAll("*", ".*") + "$"));
    }
  }
});

it("keeps the dedicated cleanup role outside the replica's explicit CMS-role deny", () => {
  const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const cleanup = read("../../infrastructure/boardwalk-video-replacement/template-v1.json");
  const replica = read("../../infrastructure/boardwalk-s3/replica-template.json");
  const name = cleanup.Resources.VideoReplacementCleanupRole.Properties.RoleName;
  expect(typeof name).toBe("string");
  const bucketPolicy = Object.values(replica.Resources).filter(resource => resource.Type === "AWS::S3::BucketPolicy");
  const denied = bucketPolicy.flatMap(resource => resource.Properties.PolicyDocument.Statement)
    .filter(statement => statement.Sid === "DenyCMSAndMediaRoles")
    .flatMap(statement => statement.Condition.ArnLike["aws:PrincipalArn"]);
  expect(denied.length).toBeGreaterThan(0);
  for (const arn of denied) {
    const glob = arn["Fn::Sub"].split(":role/")[1];
    const pattern = new RegExp("^" + glob.replaceAll("*", ".*") + "$");
    expect(name).not.toMatch(pattern);
  }
});
