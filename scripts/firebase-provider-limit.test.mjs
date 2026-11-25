import assert from "node:assert/strict";
import test from "node:test";
import { repeatAfterProviderLimit } from "./lib/firebase-provider-limit.mjs";

const everything = "firestore:rules,firestore:indexes,functions";
// The lines of the failed dev deploy of Nov. 25, 2026 (lean15), project names replaced.
const limited = `⚠  functions: Request to https://cloudfunctions.googleapis.com/v2/projects/example-dev/locations/us-central1/functions/cmsSaveContent had HTTP Error: 429, Quota exceeded for quota metric 'Per project mutation requests' and limit 'Per project mutation requests per minute per region' of service 'cloudfunctions.googleapis.com' for consumer 'project_number:100000000000'.
⚠  functions: Got "Quota Exceeded" error while trying to update projects/example-dev/locations/us-central1/functions/cmsSaveContent. Waiting to retry...
⚠  functions:  failed to update function projects/example-dev/locations/us-central1/functions/cmsSaveContent
⚠  functions: Request to https://cloudfunctions.googleapis.com/v2/projects/example-dev/locations/us-central1/functions/registerStaffProfile had HTTP Error: 429, Could not get Cloud Run service projects/example-dev/locations/us-central1/services/registerstaffprofile. Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per region' of service 'run.googleapis.com' for consumer 'project_number:100000000000'.
Request to https://cloudscheduler.googleapis.com/v1/projects/example-dev/locations/us-central1/jobs/firebase-schedule-onPublicVideoWithdrawalRecovery-us-central1 had HTTP Error: 400, URL cannot be empty: invalid argument
✔  functions[dev:cmsReplaceMediaBinary(us-central1)] Successful update operation.
⚠  functions: Deploys failed. Skipping deletes.

Functions deploy had errors with the following functions:
\tdev:onPublicVideoWithdrawalRecovery(us-central1)
Function URL (dev:cmsGetAnalytics(us-central1)): https://cmsgetanalytics.example.run.app

Error: There was an error deploying functions`;

test("repeats only what a provider limit left, and keeps the provider's error", () => {
  const repeat = repeatAfterProviderLimit(limited, everything);
  assert.deepEqual(repeat.left, ["dev:onPublicVideoWithdrawalRecovery"]);
  assert.equal(repeat.only, "functions:dev:onPublicVideoWithdrawalRecovery");
  assert.match(repeat.error, /HTTP Error: 429, Quota exceeded/);
});

test("names every Function that a limit left", () => {
  const log = limited.replace("\tdev:onPublicVideoWithdrawalRecovery(us-central1)", "\tdev:donationHealth(us-central1)\n\tdev:onNoBuildPostConfirmationRecovery(us-central1)\n\nUnable to set the invoker for the IAM policy on the following functions:\n\tdev:donationHealth(us-central1)");
  assert.equal(repeatAfterProviderLimit(log, everything).only, "functions:dev:donationHealth,functions:dev:onNoBuildPostConfirmationRecovery");
});

test("repeats the whole deploy when a limit ended it before any Function was named", () => {
  const log = "Request to https://firestore.googleapis.com/v1/projects/example-dev had HTTP Error: 503, Service unavailable";
  assert.deepEqual(repeatAfterProviderLimit(log, everything), { error: log, left: [], only: everything });
});

test("stops on a failure that no provider limit explains", () => {
  const log = limited.split("\n").filter(line => !/429|Quota/.test(line)).join("\n");
  assert.match(log, /deploy had errors/);
  assert.equal(repeatAfterProviderLimit(log, everything), null);
  assert.equal(repeatAfterProviderLimit("Error: Failed to load function definition from source", everything), null);
});
