import { useLayoutEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { ExitGuardProvider, useExitGuard } from "../src/routes/ExitGuard";
import { CostLedgerGuard } from "../src/routes/CostLedgerWorkspace";

it("protects a newly dirty draft before the next guard-registration effect", () => {
  const proceed = vi.fn();
  const unload = vi.fn();
  function ImmediateMonthChange() {
    const [dirty, setDirty] = useState(false);
    const requestExit = useExitGuard();
    useLayoutEffect(() => {
      if (dirty) {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        unload(event.defaultPrevented);
        requestExit(proceed);
      }
    }, [dirty, requestExit]);
    return (
      <>
        <button onClick={() => setDirty(true)}>Edit and change month</button>
        <CostLedgerGuard dirty={dirty} busy={false} />
      </>
    );
  }
  render(
    <ExitGuardProvider>
      <ImmediateMonthChange />
    </ExitGuardProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Edit and change month" }),
  );
  expect(unload).toHaveBeenCalledWith(true);
  expect(proceed).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: "Leave with unsaved changes?" }),
  ).toBeVisible();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "You have unsaved changes in the editor. If you leave now, they will be discarded.",
  );
  expect(
    screen.getByRole("button", { name: "Discard and leave" }),
  ).toBeVisible();
});

it("blocks a route departure immediately after a draft becomes dirty", () => {
  function ImmediateRouteChange() {
    const [dirty, setDirty] = useState(false);
    const navigate = useNavigate();
    useLayoutEffect(() => {
      if (dirty) void navigate("/away");
    }, [dirty, navigate]);
    return (
      <>
        <button onClick={() => setDirty(true)}>Edit and leave</button>
        <CostLedgerGuard dirty={dirty} busy={false} />
      </>
    );
  }
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <ExitGuardProvider>
          <ImmediateRouteChange />
        </ExitGuardProvider>
      ),
    },
    { path: "/away", element: <p>Other route</p> },
  ]);
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit and leave" }));
  expect(screen.queryByText("Other route")).toBeNull();
  expect(
    screen.getByRole("dialog", { name: "Leave with unsaved changes?" }),
  ).toBeVisible();
});
