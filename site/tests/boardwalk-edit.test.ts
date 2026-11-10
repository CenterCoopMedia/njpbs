import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { boardwalkHintCookie } from "../../packages/content-core/src/boardwalk-edit";
import { BOARDWALK_EDIT_SCRIPT, BOARDWALK_EDIT_SCRIPT_HASH } from "../../packages/content-core/src/boardwalk-edit-script";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";

const html = '<a hidden="" data-boardwalk-edit="" data-content-type="post" data-content-id="0123456789abcdef0123456789abcdef">Edit in Boardwalk</a>';
async function view(host: string, cookie = "") {
  const window = new Window({ url: `https://${host}/posts/public-post/` });
  window.document.body.innerHTML = html;
  if (cookie) window.document.cookie = cookie;
  window.eval(BOARDWALK_EDIT_SCRIPT);
  return { window, button: window.document.querySelector("a")! };
}

describe("non-authorizing staff hint (#3145)", () => {
  it("uses separate dev and production names on the parent domain with no identity", () => {
    expect(boardwalkHintCookie("admin.njpbs.org", true)).toBe("bw_staff=1; Path=/; Max-Age=86400; SameSite=Lax; Domain=njpbs.org; Secure");
    expect(boardwalkHintCookie("dev-admin.example.org", true)).toBe("bw_staff_dev=1; Path=/; Max-Age=86400; SameSite=Lax; Domain=njpbs.org; Secure");
    expect(boardwalkHintCookie("dev-admin.example.org", false)).toContain("bw_staff_dev=; Path=/; Max-Age=0;");
    expect(boardwalkHintCookie("localhost", true)).toBe("bw_staff_local=1; Path=/; Max-Age=86400; SameSite=Lax");
    expect(boardwalkHintCookie("elsewhere.example", true)).toBeNull();
  });
  it("keeps a reader's button hidden and the static document intact", async () => {
    const { window, button } = await view("njpbs.org");
    expect(button.hidden).toBe(true);
    expect(window.document.body.innerHTML).toBe(html);
    expect(button.hasAttribute("href")).toBe(false);
    await window.happyDOM.close();
  });
  it.each([
    ["njpbs.org", "bw_staff=1", "https://admin.njpbs.org/open?type=post&id=0123456789abcdef0123456789abcdef"],
    ["dev-public.example.org", "bw_staff_dev=1", "https://dev-admin.example.org/open?type=post&id=0123456789abcdef0123456789abcdef"],
  ])("uses an exact editor link on %s", async (host, cookie, href) => {
    const { window, button } = await view(host, cookie);
    expect(button.hidden).toBe(false);
    expect(button.href).toBe(href);
    window.document.cookie = cookie.replace("=1", "=; Max-Age=0");
    window.dispatchEvent(new window.Event("focus"));
    expect(button.hidden).toBe(true);
    await window.happyDOM.close();
  });
  it.each([["dev-public.example.org", "bw_staff=1"], ["njpbs.org", "bw_staff_dev=1"], ["njpbs.org", "bw_staff=0"], ["preview.njpbs.org", "bw_staff=1"]])("ignores the other environment or an invalid hint on %s", async (host, cookie) => {
    const { window, button } = await view(host, cookie);
    expect(button.hidden).toBe(true);
    await window.happyDOM.close();
  });
  it("permits the exact inline bytes in the existing report-only CSP", () => {
    expect(`sha256-${createHash("sha256").update(BOARDWALK_EDIT_SCRIPT).digest("base64")}`).toBe(BOARDWALK_EDIT_SCRIPT_HASH);
    expect(SECURITY_HEADER_BASELINE["content-security-policy-report-only"]).toContain(`'${BOARDWALK_EDIT_SCRIPT_HASH}'`);
  });
});
