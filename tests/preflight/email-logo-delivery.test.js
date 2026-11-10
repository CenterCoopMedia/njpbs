import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import staffEmail from "../../functions/staff-access-email.js";
import reportDelivery from "../../functions/bug-report-delivery.js";

// publicReportEmail.logoSha256 (the approved NJ PBS assistant email header).
const APPROVED_LOGO_SHA256 =
  "8437db4b4e6c9a7302aa5e739650f744e2afd50bb978952014f6e3ec356abf03";
const EMAIL_API =
  "https://api.cloudflare.com/client/v4/accounts/test-account/email/sending/send";

afterEach(() => vi.unstubAllGlobals());

describe("email logo delivery without public publication", () => {
  it.each([
    ["staff access", () => staffEmail.renderStaffAccessEmail({
      eventType: "verify",
      displayName: "Test editor",
      verificationLink: "https://admin.njpbs.org/?mode=verifyEmail&oobCode=test",
    })],
    ["bug report", () => reportDelivery.renderBugReportEmail({
      id: `br_${"a".repeat(32)}`,
      category: "bug",
      status: "open",
    }, "report_received")],
  ])("delivers the approved inline logo for %s when the public logo is missing", async (_consumer, render) => {
    const requests = [];
    vi.stubGlobal("fetch", async (url, init) => {
      requests.push({ url, init });
      if (url !== EMAIL_API) {
        return new Response("Not found", {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      }
      return Response.json({
        success: true,
        result: {
          delivered: ["editor@example.test"],
          permanent_bounces: [],
          queued: [],
        },
      });
    });
    const send = staffEmail.createCloudflareEmailSender({
      accountId: "test-account",
      apiToken: "test-token",
      from: "sender@example.org",
      replyTo: "editor-3@example.org",
    });

    await expect(send({ to: "editor@example.test", ...render() }))
      .resolves.toMatchObject({ delivered: true });

    // The only network request sends the complete message to the email provider.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(EMAIL_API);
    const payload = JSON.parse(requests[0].init.body);
    expect([...payload.html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)]
      .map((match) => match[1])).toEqual(["cid:njpbs-email-logo"]);
    expect(payload.html).not.toMatch(/https?:\/\/[^"'<>\s]*\.(?:png|jpe?g|gif|svg|webp)\b/i);
    expect(payload.html).toContain('bgcolor="#0b223d"');
    expect(payload.attachments).toEqual([
      expect.objectContaining({
        content_id: "njpbs-email-logo",
        disposition: "inline",
        type: "image/png",
      }),
    ]);
    expect(createHash("sha256")
      .update(Buffer.from(payload.attachments[0].content, "base64"))
      .digest("hex")).toBe(APPROVED_LOGO_SHA256);
  });
});
