import { StrictMode } from "react";
import { BrowserRouter } from "react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PremiereConnectPanel } from "../src/routes/PremiereConnectRoute";

const { postFunction } = vi.hoisted(() => ({ postFunction: vi.fn() }));
vi.mock("../src/lib/functions", () => ({ postFunction }));
vi.mock("../src/lib/firebase", () => ({ emulatorMode: true }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: vi.fn() }));

const getIdToken = vi.fn(async () => "staff-token");
const pairing = { deviceName: "Editing bay", hostVersion: "26.5.2", expiresAt: "2026-10-06T20:00:00Z", status: "pending" };

function show() {
  return render(<StrictMode><BrowserRouter>
    <PremiereConnectPanel getIdToken={getIdToken} localTestMode={false} />
  </BrowserRouter></StrictMode>);
}

describe("Premiere connection approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/premiere/connect");
    postFunction.mockResolvedValue({ success: true, pairing });
  });
  afterEach(() => vi.restoreAllMocks());

  it("prefills without lookup or approval and removes only the code from the address bar", () => {
    window.history.replaceState({ usr: { from: "staff-route" }, key: "staff-route", idx: 2 }, "", "/premiere/connect?from=panel&code=kxqr7m2p#review");
    show();
    expect(screen.getByLabelText("Connection code")).toHaveValue("KXQR-7M2P");
    expect(screen.getByRole("button", { name: "Review connection" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Approve this computer" })).not.toBeInTheDocument();
    expect(postFunction).not.toHaveBeenCalled();
    expect(getIdToken).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/premiere/connect?from=panel#review");
    expect(window.history.state.usr).toEqual({ from: "staff-route" });
    expect(window.history.state.idx).toBe(2);
  });

  it.each(["%3Cimg%20src=x%20onerror=alert(1)%3E", "A".repeat(1024), "KXQR-7M2P&code=ABCD-2345"])(
    "discards and strips garbage query codes without echoing them", input => {
      window.history.replaceState(null, "", `/premiere/connect?code=${input}`);
      show();
      expect(screen.getByLabelText("Connection code")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Review connection" })).toBeDisabled();
      expect(document.querySelector("img")).toBeNull();
      expect(window.location.search).toBe("");
      expect(postFunction).not.toHaveBeenCalled();
    },
  );

  it("still requires Review, a matching-code confirmation, then an explicit Approve", async () => {
    window.history.replaceState(null, "", "/premiere/connect?code=KXQR-7M2P");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Review connection" }));
    await screen.findByRole("button", { name: "Approve this computer" });
    expect(screen.getByText("KXQR-7M2P", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/Approve only if you started this connection and this code matches the one in Premiere/)).toBeInTheDocument();
    expect(postFunction).toHaveBeenCalledTimes(1);
    expect(postFunction).toHaveBeenLastCalledWith("cmsApprovePremierePairing", "staff-token",
      { action: "lookup", userCode: "KXQR-7M2P" }, {}, { appCheck: true, operation: "account" });
    fireEvent.click(screen.getByRole("button", { name: "Approve this computer" }));
    await screen.findByText("Connection approved. Return to Premiere to open your library.");
    expect(postFunction).toHaveBeenCalledTimes(2);
    expect(postFunction).toHaveBeenLastCalledWith("cmsApprovePremierePairing", "staff-token",
      { action: "approve", userCode: "KXQR-7M2P" }, {}, { appCheck: true, operation: "account" });
  });

  it("keeps manual entry when no query code is provided", async () => {
    show();
    const code = screen.getByLabelText("Connection code");
    expect(code).toHaveValue("");
    fireEvent.change(code, { target: { value: "abcd2345" } });
    fireEvent.click(screen.getByRole("button", { name: "Review connection" }));
    await waitFor(() => expect(postFunction).toHaveBeenCalledWith("cmsApprovePremierePairing", "staff-token",
      { action: "lookup", userCode: "ABCD2345" }, {}, { appCheck: true, operation: "account" }));
  });
});
