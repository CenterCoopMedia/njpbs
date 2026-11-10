import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import emailModule from "../../functions/staff-access-email.js";

const {
  EmailDeliveryError,
  MAX_JSON_REQUEST_BYTES,
  createCloudflareEmailSender,
  deliverStaffAccessEmail,
  queueStaffAccessEmail,
  recoverExpiredSendingEmails,
  renderStaffAccessEmail,
  staffEmailIdentity,
} = emailModule;

const OFFICIAL_EMAIL_LOGO_SHA256 =
  "8437db4b4e6c9a7302aa5e739650f744e2afd50bb978952014f6e3ec356abf03";

function expectOfficialEmailHeader(message, serviceLabel) {
  expect(message.html).toContain('bgcolor="#0b223d"');
  expect(message.html).toContain("border-bottom:4px solid #2638c4");
  expect(message.html).not.toContain("border-top:8px solid #2638c4");
  expect(message.html).toContain('src="cid:njpbs-email-logo"');
  expect(message.html).toContain('width="228"');
  expect(message.html).toContain(`>${serviceLabel}</p>`);
  expect(message.attachments).toEqual([
    expect.objectContaining({
      content_id: "njpbs-email-logo",
      disposition: "inline",
      filename: "njpbs-horizontal-white.png",
      type: "image/png",
    }),
  ]);
  expect(
    createHash("sha256")
      .update(Buffer.from(message.attachments[0].content, "base64"))
      .digest("hex"),
  ).toBe(OFFICIAL_EMAIL_LOGO_SHA256);
}

afterEach(() => vi.unstubAllEnvs());

describe("staff access email", () => {
  const message = { to: "person@example.org", subject: "Account status", html: "<p>Ready</p>", text: "Ready" };

  it("refuses unset runtime sender defaults before contacting the provider", async () => {
    vi.stubEnv("CMS_STAFF_EMAIL_FROM", undefined);
    vi.stubEnv("CMS_STAFF_EMAIL_REPLY_TO", undefined);
    const fetchFn = vi.fn();
    const send = createCloudflareEmailSender({ fetchFn, accountId: "account-id", apiToken: "synthetic-token" });
    expect(staffEmailIdentity()).toMatchObject({ fromAddress: "", replyTo: "" });
    await expect(send(message)).rejects.toMatchObject({ kind: "retryable", message: "Staff email delivery is not configured" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["", "info@njpbs.org"],
    ["sender@example.org", ""],
    ["REPLACE_ME@example.org", "info@njpbs.org"],
    ["sender@example.org", " REPLACE_ME@example.org "],
  ])("refuses empty or template sender/reply configuration before provider contact: %s / %s", async (from, replyTo) => {
    const fetchFn = vi.fn();
    const send = createCloudflareEmailSender({ fetchFn, accountId: "account-id", apiToken: "synthetic-token", from, replyTo });
    await expect(send(message)).rejects.toMatchObject({ kind: "retryable", message: "Staff email delivery is not configured" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("reports the reviewed application sender and reply path", () => {
    expect(
      staffEmailIdentity({
        from: "FIXTURE-3D530F2926@EXAMPLE.ORG",
        replyTo: "INFO@NJPBS.ORG",
      }),
    ).toEqual({
      fromAddress: "fixture-3d530f2926@example.org",
      fromName: "NJ PBS",
      replyTo: "info@njpbs.org",
    });
  });

  it("renders branded, viewport-safe verification email with an accessible CTA", () => {
    const verification = renderStaffAccessEmail({
      eventType: "verify",
      displayName: "Blake <Sutton>",
      verificationLink:
        "https://admin.njpbs.org/?mode=verifyEmail&oobCode=safe",
    });
    expect(verification.subject).toBe("Verify your NJ PBS Admin email");
    expect(verification.text).toContain("Verify your email");
    expect(verification.text).toContain(
      "Verify my email: https://admin.njpbs.org/?mode=verifyEmail&oobCode=safe",
    );
    expect(verification.html).toContain("<!doctype html>");
    expect(verification.html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(verification.html).toContain('width="600"');
    expect(verification.html).toContain("max-width:600px");
    expect(verification.html).toContain("max-width:100%;height:auto");
    expect(verification.html).toContain("#2638c4");
    expect(verification.html).toContain("#090f2f");
    expectOfficialEmailHeader(verification, "Staff services");
    expect(verification.html).toContain('alt="NJ PBS"');
    expect(verification.html).not.toContain("njpbs-horizontal-white-navy.png");
    expect(verification.html).toContain("display:none;max-height:0");
    expect(verification.html).toContain("min-height:44px");
    expect(verification.html).toContain("line-height:44px");
    expect(verification.html.match(/<a\b/g)).toHaveLength(1);
    expect(verification.html).toContain("Blake &lt;Sutton&gt;");
    expect(verification.html).toContain(
      'href="https://admin.njpbs.org/?mode=verifyEmail&amp;oobCode=safe"',
    );
  });

  it("renders each access template with matching HTML and text content", () => {
    const received = renderStaffAccessEmail({
      eventType: "received",
      displayName: "Blake Sutton",
      reference: "NJPBS-BLAKE-1",
    });
    expect(received.subject).toBe("NJ PBS Admin access request received");
    expect(received.html).toContain("Your request is in review");
    expect(received.text).toContain("Your request is in review");
    expect(received.html).toContain("NJPBS-BLAKE-1");
    expect(received.text).toContain("Reference: NJPBS-BLAKE-1");

    const approved = renderStaffAccessEmail({
      eventType: "approved",
      displayName: "Blake Sutton",
      role: "editor",
      reference: "NJPBS-BLAKE-1",
    });
    expect(approved.text).toContain(
      "An administrator approved your account with editor access",
    );
    expect(approved.text).toContain("https://admin.njpbs.org");
    expect(approved.html).toContain(
      "An administrator approved your account with editor access",
    );

    const denied = renderStaffAccessEmail({
      eventType: "denied",
      displayName: "Blake Sutton",
      reference: "NJPBS-BLAKE-1",
    });
    expect(denied.subject).toBe("NJ PBS Admin access request update");
    expect(denied.html).toContain("Your access request was not approved");
    expect(denied.text).toContain("Your access request was not approved");
    expect(denied.text).toContain("Reference: NJPBS-BLAKE-1");

    const reset = renderStaffAccessEmail({
      eventType: "password_reset",
      displayName: "Blake Sutton",
      passwordResetLink: "https://example.firebaseapp.com/reset?oobCode=safe",
    });
    expect(reset.subject).toBe("Reset your NJ PBS Admin password");
    expect(reset.text).toContain(
      "Reset my password: https://example.firebaseapp.com/reset?oobCode=safe",
    );
    expect(reset.html).toContain(
      'href="https://example.firebaseapp.com/reset?oobCode=safe"',
    );
  });

  it("sends through Cloudflare Email Service from the named mail subdomain", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              delivered: ["person@example.org"],
              permanent_bounces: [],
              queued: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const send = createCloudflareEmailSender({
      fetchFn,
      accountId: "account-id",
      apiToken: "email-only-token",
      from: "fixture-3d530f2926@example.org",
      replyTo: "info@njpbs.org",
    });
    const attachments = [{
      content: "cG5n",
      content_id: "njpbs-email-logo",
      disposition: "inline",
      filename: "njpbs-horizontal-white.png",
      type: "image/png",
    }];

    await expect(
      send({
        to: "person@example.org",
        subject: "Account status",
        html: "<p>Ready</p>",
        text: "Ready",
        attachments,
      }),
    ).resolves.toMatchObject({
      provider: "cloudflare-email-service",
      delivered: true,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/email/sending/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer email-only-token",
        }),
        body: expect.any(String),
      }),
    );
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      to: "person@example.org",
      from: {
        address: "fixture-3d530f2926@example.org",
        name: "NJ PBS",
      },
      reply_to: "info@njpbs.org",
      subject: "Account status",
      html: "<p>Ready</p>",
      text: "Ready",
      attachments,
    });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).not.toHaveProperty("bcc");
  });

  it("passes an optional BCC without accepting a BCC-only provider result", async () => {
    const bcc = ["fixture-08a6ef6987@example.org", "fixture-e10a143775@example.org"];
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              delivered: bcc,
              permanent_bounces: [],
              queued: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const send = createCloudflareEmailSender({
      fetchFn,
      accountId: "account-id",
      apiToken: "email-only-token",
      from: "fixture-3d530f2926@example.org",
      replyTo: "info@njpbs.org",
    });

    await expect(
      send({
        to: "reporter@example.org",
        bcc,
        subject: "Report received",
        html: "<p>Received</p>",
        text: "Received",
      }),
    ).resolves.toMatchObject({ delivered: false, queued: false });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({
      to: "reporter@example.org",
      bcc,
    });
  });

  it("rejects an oversized request before contacting the provider", async () => {
    const fetchFn = vi.fn();
    const send = createCloudflareEmailSender({
      fetchFn,
      accountId: "account-id",
      apiToken: "email-only-token",
      from: "fixture-3d530f2926@example.org",
      replyTo: "info@njpbs.org",
    });

    await expect(
      send({
        to: "person@example.org",
        subject: "Too large",
        html: "x".repeat(MAX_JSON_REQUEST_BYTES),
        text: "Too large",
      }),
    ).rejects.toMatchObject({ kind: "terminal" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies a network failure as ambiguous and does not guess delivery", async () => {
    const send = createCloudflareEmailSender({
      fetchFn: vi.fn(async () => {
        throw new Error("connection reset");
      }),
      accountId: "account-id",
      apiToken: "email-only-token",
      from: "fixture-3d530f2926@example.org",
      replyTo: "info@njpbs.org",
    });

    await expect(
      send({
        to: "person@example.org",
        subject: "Account status",
        html: "<p>Ready</p>",
        text: "Ready",
      }),
    ).rejects.toMatchObject({
      name: "EmailDeliveryError",
      kind: "ambiguous",
    });
  });

  it("marks a deterministic rendering failure failed before provider contact", async () => {
    const update = vi.fn();
    const transactionUpdate = vi.fn();
    const ref = {
      path: "staffAccessEmailOutbox/verify-render-1",
      update,
      get: vi.fn(async () => ({ exists: true, data: () => row })),
    };
    const row = {
      state: "pending",
      nextAttemptAt: new Date("2026-08-30T13:00:00.000Z"),
      attemptCount: 0,
      eventType: "verify",
      to: "person@example.org",
    };
    const firestore = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ref) })),
      runTransaction: vi.fn(async (callback) =>
        callback({
          get: vi.fn(async () => ({ exists: true, data: () => row })),
          update: transactionUpdate,
        }),
      ),
    };
    const sendEmail = vi.fn();

    await expect(
      deliverStaffAccessEmail("verify-render-1", {
        firestore,
        now: () => new Date("2026-08-30T13:00:00.000Z"),
        renderEmail: vi.fn(async () => {
          throw new Error("unsupported local glyph");
        }),
        sendEmail,
      }),
    ).resolves.toEqual({ state: "failed" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(transactionUpdate).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({ state: "failed", nextAttemptAt: null }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("renders before claim and keeps provider network ambiguity unknown", async () => {
    const events = [];
    const now = new Date("2026-08-30T13:00:00.000Z");
    const update = vi.fn(async (changes) => events.push(["state", changes]));
    const row = {
      state: "pending",
      nextAttemptAt: now,
      updatedAt: now,
      attemptCount: 0,
      deliveryId: "verify-1",
      eventType: "verify",
      to: "person@example.org",
    };
    const ref = {
      path: "staffAccessEmailOutbox/verify-1",
      update,
      get: vi.fn(async () => ({ exists: true, data: () => row })),
    };
    const firestore = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ref) })),
      runTransaction: vi.fn(async (callback) =>
        callback({
          get: vi.fn(async () => ({ exists: true, data: () => row })),
          update: vi.fn(() => events.push(["claim"])),
        }),
      ),
    };

    await expect(
      deliverStaffAccessEmail("verify-1", {
        firestore,
        now: () => now,
        renderEmail: vi.fn(async () => {
          events.push(["render"]);
          return {
            subject: "Verify",
            html: "<p>Verify</p>",
            text: "Verify",
          };
        }),
        sendEmail: vi.fn(async () => {
          events.push(["provider"]);
          throw new EmailDeliveryError("Provider result unknown", {
            kind: "ambiguous",
          });
        }),
      }),
    ).resolves.toEqual({ state: "unknown" });
    expect(events.slice(0, 3).map(([event]) => event)).toEqual([
      "render",
      "claim",
      "provider",
    ]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ state: "unknown", nextAttemptAt: null }),
    );
  });

  it.each(["onboarding_invite", "unknown"])("rejects the retired or unknown template %s", (eventType) => {
    try {
      renderStaffAccessEmail({ eventType });
      throw new Error("Expected the template to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(error).toMatchObject({ kind: "terminal" });
    }
  });

  it("marks an expired sending lease unknown without risking a duplicate", async () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    const ref = { path: "staffAccessEmailOutbox/message-1" };
    const row = {
      state: "sending",
      leaseUntil: new Date(now.getTime() - 1),
    };
    const update = vi.fn();
    const transaction = {
      get: vi.fn(async () => ({ exists: true, data: () => row })),
      update,
    };
    const query = {
      where: vi.fn(() => query),
      limit: vi.fn(() => query),
      get: vi.fn(async () => ({ docs: [{ id: "message-1", ref }] })),
    };
    const firestore = {
      collection: vi.fn(() => query),
      runTransaction: vi.fn(async (callback) => callback(transaction)),
    };

    await expect(
      recoverExpiredSendingEmails({ firestore, now: () => now }),
    ).resolves.toEqual([{ state: "unknown" }]);
    expect(update).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({
        state: "unknown",
        leaseUntil: null,
        nextAttemptAt: null,
      }),
    );
  });
});
