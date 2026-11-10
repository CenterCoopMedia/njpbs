import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveProductionDevices, type DeviceTransport } from "../src/components/LiveProductionDevices";
import { HttpError } from "../src/lib/functions";

afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, "clipboard"); });
describe("studio device enrollment", () => {
  it("shows a pairing code once, refreshes without recovering it, and requires explicit revocation", async () => {
    let created = false, revoked = false;
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (value: string) => { copied = value; } } });
    const send: DeviceTransport = async (request: any) => {
      if (request.action === "create_pairing") {
        created = true;
        return { pairingCode: "ABCD-EFGH-JKLM", deviceId: "fixture-device", expiresAtMs: 300000, expiresInMs: 300000 };
      }
      if (request.action === "revoke_device") { revoked = true; return {}; }
      return { devices: created ? [{ id: "fixture-device", name: "Studio PC", active: !revoked,
        state: revoked ? "revoked" : "enrolled", sessionId: null }] : [] };
    };
    const view = render(<LiveProductionDevices send={send} />);
    expect(await screen.findByText("No studio devices are enrolled.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Studio PC name" }), { target: { value: "Studio PC" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    expect(await screen.findByText("ABCD-EFGH-JKLM")).toBeVisible();
    expect(screen.getByRole("timer")).toHaveTextContent(/^[45]:[0-5][0-9]$/);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByText("Code copied.")).toBeVisible();
    expect(copied).toBe("ABCD-EFGH-JKLM");
    fireEvent.click(screen.getByRole("button", { name: "Hide pairing code" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh devices" })).toBeEnabled());
    expect(screen.queryByText("ABCD-EFGH-JKLM")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Studio PC" }));
    expect(revoked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revoked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Studio PC" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    expect(await screen.findByText("Device access revoked.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke Studio PC" })).not.toBeInTheDocument();
    view.unmount();
    render(<LiveProductionDevices send={send} />);
    expect(await screen.findByText(/Revoked/)).toBeVisible();
    expect(screen.queryByText("ABCD-EFGH-JKLM")).not.toBeInTheDocument();
  });
  it("keeps a failed pairing recoverable and does not display server errors or secrets", async () => {
    const send: DeviceTransport = async (request: any) => {
      if (request.action === "create_pairing") throw new Error("synthetic-sensitive-error");
      return { devices: [] };
    };
    render(<LiveProductionDevices send={send} />);
    await screen.findByText("No studio devices are enrolled.");
    fireEvent.change(screen.getByRole("textbox", { name: "Studio PC name" }), { target: { value: "Studio PC" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    expect(await screen.findByText(/Device settings could not be updated/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Studio PC name" })).toHaveValue("Studio PC");
    expect(screen.queryByText("synthetic-sensitive-error")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create pairing code" })).toBeEnabled();
  });
  it.each(["expired", "failed"])("shows server %s status and recovery through explicit revocation", async state => {
    let revoked = false;
    const send: DeviceTransport = async (request: any) => {
      if (request.action === "revoke_device") revoked = true;
      return { devices: [{ id: "fixture-device", name: "Studio PC", active: false,
        state: revoked ? "revoked" : state, sessionId: null }] };
    };
    render(<LiveProductionDevices send={send} />);
    expect(await screen.findByText(`Pairing ${state}`)).toBeVisible();
    expect(screen.getByText("Revoke this device, then create a new pairing code to pair again.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Studio PC" }));
    expect(revoked).toBe(false);
    expect(await screen.findByRole("group", { name: "Confirm revocation for Studio PC" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Revoke Studio PC" })).toHaveFocus();
    expect(revoked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Studio PC" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    expect(await screen.findByText("Device access revoked.")).toBeVisible();
    expect(screen.getByText("Revoked")).toBeVisible();
    expect(screen.queryByText(`Pairing ${state}`)).not.toBeInTheDocument();
    expect(screen.queryByText(/Revoke this device, then/)).not.toBeInTheDocument();
  });
  it("renders server pending and enrolling states without deriving status from the browser clock", async () => {
    const send: DeviceTransport = async () => ({ devices: [
      { id: "pending", name: "Unused code", active: false, state: "pending", expiresAtMs: 0, sessionId: null },
      { id: "enrolling", name: "Slow token issue", active: false, state: "enrolling", expiresAtMs: 0, sessionId: null },
    ] });
    render(<LiveProductionDevices send={send} />);
    const list = await screen.findByRole("list", { name: "Studio devices" });
    expect(await within(list).findByText("Pairing pending")).toBeVisible();
    expect(within(list).getByText("Pairing in progress")).toBeVisible();
    expect(screen.queryByText(/Revoke this device, then/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
  });
  it.each(["revoked", "failed"])("confirms deletion of a %s device and refreshes the list", async state => {
    let deleted = false;
    const send: DeviceTransport = async (request: any) => {
      if (request.action === "delete_device") { expect(request.deviceId).toBe("fixture-device"); deleted = true; return {}; }
      return { devices: deleted ? [] : [{ id: "fixture-device", name: "Studio PC", active: false, state, sessionId: null }] };
    };
    render(<LiveProductionDevices send={send} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Studio PC" }));
    expect(deleted).toBe(false);
    expect(await screen.findByRole("group", { name: "Confirm deletion for Studio PC" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete Studio PC" })).toHaveFocus();
    expect(deleted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete Studio PC" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
    expect(await screen.findByText("Device deleted.")).toBeVisible();
    expect(await screen.findByText("No studio devices are enrolled.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete Studio PC" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh devices" })).toHaveFocus();
  });
  it("keeps a referenced device and explains a refused deletion without showing a server body", async () => {
    const send: DeviceTransport = async (request: any) => {
      if (request.action === "delete_device") throw new HttpError(409, "synthetic-private-error", { code: "device_referenced" });
      return { devices: [{ id: "fixture-device", name: "Studio PC", active: false, state: "revoked", sessionId: null }] };
    };
    render(<LiveProductionDevices send={send} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Studio PC" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
    expect(await screen.findByText(/This device is used by a studio session or saved mapping/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete Studio PC" })).toBeVisible();
    expect(screen.queryByText("synthetic-private-error")).not.toBeInTheDocument();
  });
  it("focuses each confirmation when staff switch actions on the same failed device", async () => {
    const send: DeviceTransport = async () => ({ devices: [{ id: "fixture-device", name: "Studio PC", active: false, state: "failed", sessionId: null }] });
    render(<LiveProductionDevices send={send} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Studio PC" }));
    expect(screen.getByRole("group", { name: "Confirm revocation for Studio PC" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete Studio PC" }));
    expect(screen.getByRole("group", { name: "Confirm deletion for Studio PC" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Studio PC" }));
    expect(screen.getByRole("group", { name: "Confirm revocation for Studio PC" })).toHaveFocus();
  });
});
