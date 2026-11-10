import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it } from "vitest";
import { useSuccessNotice } from "../src/components/ui/SuccessNoticeRegion";
import { ROUTE_PATHS } from "../src/lib/routes";
import { ShellLayout } from "../src/routes/ShellLayout";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";

it.each(["Back", "new navigation"])("announces a save across sections and rejects a prior visit's completion after %s", async returnMethod => {
  const completions: (() => void)[] = [];
  function SaveOwner() {
    const notice = useSuccessNotice();
    return <button onClick={() => completions.push(() => notice.show("Settings draft saved."))}>Start settings save</button>;
  }
  const router = createMemoryRouter([{ path: "/", element: <ShellLayout />, children: [
    { path: ROUTE_PATHS.adminSettings, element: <SaveOwner />, handle: { title: "Admin settings" } },
    { path: ROUTE_PATHS.adminCosts, element: <p>Costs</p>, handle: { title: "Costs" } },
  ] }], { initialEntries: [ROUTE_PATHS.adminSettings] });
  const shell: ShellData = { principal: { id: "fixture", grants: [{ role: "super_admin" }] },
    user: { uid: "fixture", email: "editor@example.org" }, userDoc: { role: "super_admin" }, signOut: () => {}, navigationShares: [] };
  const view = render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Start settings save" }));
  await act(async () => { await router.navigate(`${ROUTE_PATHS.adminSettings}?section=nj-decides-brand`); });
  act(() => completions[0]());
  expect(view.container.querySelector(".success-notice")).toHaveTextContent("Settings draft saved.");
  fireEvent.click(screen.getByRole("button", { name: "Start settings save" }));
  await act(async () => { await router.navigate(ROUTE_PATHS.adminCosts); });
  await act(async () => {
    if (returnMethod === "Back") await router.navigate(-1);
    else await router.navigate(ROUTE_PATHS.adminSettings);
  });
  act(() => completions[1]());
  expect(view.container.querySelector(".success-notice")).toBeNull();
});
