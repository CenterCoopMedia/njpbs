import { expect, it } from "vitest";
import { enrollmentOperatorRefusal } from "../../scripts/enroll-public-release-change-log.mjs";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import protocol from "../../functions/lib/public-release-pair.js";
it("reports fixed protocol and enrollment refusals without source or credential details", () => {
  expect(enrollmentOperatorRefusal(new protocol.PublicReleaseProtocolError())).toEqual({ status: "refused", code: "protocol-refused" });
  expect(enrollmentOperatorRefusal(new enrollment.PublicReleaseEnrollmentError("enrollment-cutoff-mismatch")))
    .toEqual({ status: "refused", code: "enrollment-cutoff-mismatch" });
  expect(enrollmentOperatorRefusal(new enrollment.PublicReleaseEnrollmentError("private details"))).toEqual({ status: "refused", code: "enrollment-failed" });
  expect(enrollmentOperatorRefusal(new Error("private details"))).toEqual({ status: "refused", code: "enrollment-failed" });
});
it.each([4, 10, 14])("distinguishes retryable gRPC %s without echoing messages", grpcCode => {
  expect(enrollmentOperatorRefusal(Object.assign(new Error("private details"), { code: grpcCode })))
    .toEqual({ status: "refused", code: "storage-unavailable", grpcCode });
});
it("separates access failure and cancellation from transport retries", () => {
  expect(enrollmentOperatorRefusal(Object.assign(new Error("private details"), { code: 7 })))
    .toEqual({ status: "refused", code: "storage-refused", grpcCode: 7 });
  expect(enrollmentOperatorRefusal(new DOMException("private details", "AbortError")))
    .toEqual({ status: "refused", code: "cancelled" });
});
