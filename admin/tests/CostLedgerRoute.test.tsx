import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  Link,
  MemoryRouter,
  Route,
  Routes,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CostLedgerRoute,
  CostLedgerSurface,
  type CostLedgerView,
} from "../src/routes/CostLedgerRoute";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  cmsCostLedger: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsCostLedger: mocks.cmsCostLedger,
}));

function machine(id: string) {
  return {
    id,
    label: id,
    purchaseCents: null,
    lifeMonths: null,
    watts: null,
    hoursPerMonth: null,
    centsPerKwh: null,
    internetShareCents: null,
  };
}

function ledger(
  canEdit: boolean,
  options: Partial<Pick<CostLedgerView, "period" | "periodStatus">> = {},
): CostLedgerView {
  return {
    success: true,
    canEdit,
    currency: "USD",
    currentPeriod: "2026-09",
    period: options.period ?? "2026-09",
    periodStatus: options.periodStatus ?? "open",
    monthlyCents: 0,
    annualRunRateCents: 0,
    yearToDateCents: 12345,
    yearToDateMonths: 2,
    blankLineCount: 1,
    knownLineCount: 1,
    byCategory: { cloud: 0, ai: 0, saas: 0, hardware: 0 },
    byProject: { cms: 0, spotlight: 0, hosting: 0, tooling: 0 },
    lines: [
      {
        id: "claude",
        label: "Claude",
        category: "ai",
        project: "tooling",
        source: "manual",
        cadence: "monthly",
        monthlyCents: 0,
        standingCents: 0,
        vendor: "Anthropic",
        notes: "A recorded zero is a real zero.",
        enabled: true,
        freshnessStatus: "manual",
        freshnessAt: null,
        state: "known",
      },
      {
        id: "domains",
        label: "Domain registrations",
        category: "cloud",
        project: "hosting",
        source: "manual",
        cadence: "monthly",
        monthlyCents: null,
        standingCents: null,
        vendor: "",
        notes: "Enter a cost when one is billed.",
        enabled: true,
        freshnessStatus: "blank",
        freshnessAt: null,
        state: "blank",
      },
      {
        id: "aws-s3",
        label: "AWS S3",
        category: "cloud",
        project: "cms",
        source: "auto",
        cadence: "monthly",
        monthlyCents: 123,
        standingCents: null,
        vendor: "Amazon Web Services",
        notes: "Automatic pull.",
        enabled: true,
        freshnessStatus: "fresh",
        freshnessAt: "2026-09-22T15:00:00.000Z",
        state: "known",
      },
    ],
    comparisons: [
      {
        id: "ghost-starter",
        vendor: "Ghost",
        product: "Ghost(Pro) Starter",
        status: "published",
        priceLabel: "$18 per month, billed yearly",
        monthlyCents: 1800,
        annualCents: 21600,
        rangeNote: "Initial audience price.",
        sourceUrl: "https://ghost.org/pricing/",
        sourceReadOn: "2026-09-25",
        excludes: "labor",
        notes: "Platform and hosting only.",
      },
      {
        id: "wordpress-vip",
        vendor: "WordPress VIP",
        product: "WordPress VIP",
        status: "quote-required",
        priceLabel: "This must not render",
        monthlyCents: 250000,
        annualCents: 3000000,
        rangeNote: "The vendor publishes no dollar amount.",
        sourceUrl: "https://wpvip.com/pricing/",
        sourceReadOn: "2026-09-25",
        excludes: "labor",
        notes: "Platform and hosting only.",
      },
    ],
    snapshots: [
      {
        id: "2026-09-22",
        period: "2026-09",
        takenAt: "2026-09-22T15:00:00.000Z",
        monthlyCents: 123,
        annualRunRateCents: 1476,
        blankLineCount: 1,
      },
    ],
    periods: [
      { id: "2026-08", status: "closed" },
      { id: "2026-09", status: "open" },
    ],
    hardware: {
      machines: [
        machine("node-services"),
        machine("node-compute"),
        machine("node-gpu-a"),
        machine("node-gpu-b"),
        machine("node-offsite"),
      ],
    },
    csv: "Period,Amount\n2026-09,1.23\n",
  };
}

function shell(role: "admin" | "super_admin" | "editor"): ShellData {
  return {
    principal: { id: "person", grants: [{ role }] },
    user: {
      uid: "person",
      email: "account-17@example.org",
      displayName: "Test person",
    },
    userDoc: { role },
    signOut: vi.fn(),
  } as unknown as ShellData;
}

function renderRoute(role: "admin" | "super_admin" | "editor") {
  return render(
    <ShellProvider value={shell(role)}>
      <MemoryRouter initialEntries={["/admin/settings/costs"]}>
        <Routes>
          <Route path="/" element={<p>Newsroom home</p>} />
          <Route path="/admin/settings/costs" element={<CostLedgerRoute />} />
        </Routes>
      </MemoryRouter>
    </ShellProvider>,
  );
}

async function openAmount(label: string) {
  const opener = await screen.findByRole("button", {
    name: (name) => name.startsWith(`${label} amount for September 2026:`),
  });
  fireEvent.click(opener);
  return screen.getByRole("textbox", {
    name: `${label} amount for September 2026`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.cmsCostLedger.mockImplementation(
    async (_token: string, request: { action: string; period?: string }) => {
      if (request.action !== "view") return { success: true };
      return request.period === "2026-08"
        ? ledger(true, { period: "2026-08", periodStatus: "closed" })
        : ledger(true);
    },
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:cost-ledger"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

function tab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}
async function amount(label = "Claude") {
  tab("Ledger");
  return openAmount(label);
}
function standing(label = "Claude") {
  tab("Ledger");
  fireEvent.click(screen.getByRole("button", { name: `Edit ${label} line` }));
  return screen.getByRole("form", { name: `${label} standing line` });
}
function hardwareMachine(label = "node-services") {
  tab("Hardware");
  fireEvent.click(
    screen.getByRole("button", { name: `Edit ${label} assumptions` }),
  );
}
function reference(label = "Ghost(Pro) Starter") {
  tab("Price references");
  fireEvent.click(
    screen.getByRole("button", { name: `Edit ${label} reference` }),
  );
}
function change(name: string, value: string) {
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
}
async function ready() {
  await screen.findByRole("tab", { name: "Ledger" });
}
async function saved() {
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Ledger month" }),
    ).toBeEnabled(),
  );
}
function menuAction(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "More cost actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("Cost ledger route", () => {
  it.each([
    { index: 0, standingCents: 12001, cadence: "annual" as const },
    { index: 2, standingCents: null, cadence: "monthly" as const },
  ])(
    "preserves exact standing scope for line $index",
    async ({ index, standingCents, cadence }) => {
      const initial = ledger(true),
        line = initial.lines[index];
      Object.assign(line, { standingCents, cadence, source: "manual" });
      const mutate = vi.fn().mockResolvedValue({ success: true });
      render(
        <CostLedgerSurface
          load={vi.fn().mockResolvedValue(initial)}
          mutate={mutate}
        />,
      );
      await ready();
      const form = standing(line.label);
      fireEvent.change(
        screen.getByRole("combobox", { name: `${line.label} category` }),
        { target: { value: "saas" } },
      );
      fireEvent.change(
        screen.getByRole("combobox", { name: `${line.label} project` }),
        { target: { value: "spotlight" } },
      );
      change(`${line.label} vendor`, "Updated vendor");
      change(`${line.label} notes`, "Unused service");
      fireEvent.click(
        screen.getByRole("checkbox", { name: `${line.label} active` }),
      );
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(mutate).toHaveBeenCalledExactlyOnceWith({
          action: "saveLine",
          line: {
            id: line.id,
            label: line.label,
            cadence,
            amountCents: standingCents,
            category: "saas",
            project: "spotlight",
            vendor: "Updated vendor",
            notes: "Unused service",
            enabled: false,
          },
        }),
      );
      await saved();
    },
  );
  it("cancels standing changes and keeps inactive amounts unavailable", async () => {
    const view = ledger(true);
    Object.assign(view.lines[0], { enabled: false, state: "inactive" });
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(view)}
        mutate={mutate}
      />,
    );
    await ready();
    standing();
    change("Claude vendor", "Discard me");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    standing();
    expect(screen.getByRole("textbox", { name: "Claude vendor" })).toHaveValue(
      "Anthropic",
    );
    expect(
      screen.queryByRole("textbox", {
        name: "Claude amount for September 2026",
      }),
    ).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("retains rejected line edits and reports the exact error", async () => {
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={vi
          .fn()
          .mockRejectedValue(new Error("Line changed. Reload and retry."))}
      />,
    );
    await ready();
    const form = standing();
    change("Claude notes", "Keep this edit");
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Line changed. Reload and retry.",
    );
    expect(
      screen.getByRole("alert").closest(".cost-ledger-inspector"),
    ).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Keep this edit",
    );
  });
  it("retains drafts across all four tasks and selectively refreshes saved and untouched scopes", async () => {
    const initial = ledger(true),
      updated = ledger(true);
    updated.lines[0].notes = "Saved notes";
    updated.lines[1].monthlyCents = 3400;
    updated.lines[2].vendor = "Refreshed vendor";
    let reload!: (view: CostLedgerView) => void;
    const load = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise<CostLedgerView>((resolve) => {
            reload = resolve;
          }),
      );
    render(
      <CostLedgerSurface
        load={load}
        mutate={vi.fn().mockResolvedValue({ success: true })}
      />,
    );
    await ready();
    change((await amount()).getAttribute("aria-label")!, "45.67");
    standing();
    change("Claude notes", "Saved notes ");
    standing("Domain registrations");
    change("Domain registrations notes", "Unsaved notes");
    hardwareMachine();
    change("node-services purchase cost", "1200");
    reference();
    change("Ghost(Pro) Starter monthly amount", "19.25");
    const form = standing();
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("textbox", { name: "Claude notes" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Edit AWS S3 line" }),
    ).toBeDisabled();
    await act(async () => reload(updated));
    await saved();
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Saved notes",
    );
    expect(await amount()).toHaveValue("45.67");
    standing("Domain registrations");
    expect(
      screen.getByRole("textbox", { name: "Domain registrations notes" }),
    ).toHaveValue("Unsaved notes");
    expect(await amount("Domain registrations")).toHaveValue("34.00");
    hardwareMachine();
    expect(
      screen.getByRole("textbox", { name: "node-services purchase cost" }),
    ).toHaveValue("1200");
    reference();
    expect(
      screen.getByRole("textbox", {
        name: "Ghost(Pro) Starter monthly amount",
      }),
    ).toHaveValue("19.25");
    standing("AWS S3");
    expect(screen.getByRole("textbox", { name: "AWS S3 vendor" })).toHaveValue(
      "Refreshed vendor",
    );
  });
  it.each([
    ["12.34", 1234],
    ["", null],
    ["0", 0],
    ["-1.23", -123],
  ])("saves monthly %s as exact cents %s", async (value, cents) => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    fireEvent.change(await amount(), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledExactlyOnceWith({
        action: "savePeriodAmount",
        lineId: "claude",
        period: "2026-09",
        amountCents: cents,
      }),
    );
    await saved();
  });
  it.each(["1.234", "1000000000.01"])(
    "rejects invalid money %s before mutation",
    async (value) => {
      const mutate = vi.fn();
      render(
        <CostLedgerSurface
          load={vi.fn().mockResolvedValue(ledger(true))}
          mutate={mutate}
        />,
      );
      await ready();
      fireEvent.change(await amount(), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enter a dollar amount",
      );
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it("merges an edited machine into the latest complete five-machine set", async () => {
    const initial = ledger(true),
      latest = ledger(true);
    latest.hardware.machines[1].watts = 222;
    const load = vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(latest),
      mutate = vi.fn().mockResolvedValue({ success: true });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    hardwareMachine();
    change("node-services purchase cost", "1200");
    change("node-services life months", "48");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledExactlyOnceWith({
        action: "saveHardware",
        hardware: {
          machines: [
            {
              ...machine("node-services"),
              purchaseCents: 120000,
              lifeMonths: 48,
            },
            { ...machine("node-compute"), watts: 222 },
            machine("node-gpu-a"),
            machine("node-gpu-b"),
            machine("node-offsite"),
          ],
        },
      }),
    );
    await saved();
  });
  it("preserves newer independent fields on the edited machine", async () => {
    const initial = ledger(true),
      latest = ledger(true);
    latest.hardware.machines[0].watts = 222;
    const load = vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(latest),
      mutate = vi.fn().mockResolvedValue({ success: true });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    hardwareMachine();
    change("node-services internet share", "12.34");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        action: "saveHardware",
        hardware: {
          machines: [
            { ...machine("node-services"), watts: 222, internetShareCents: 1234 },
            ...latest.hardware.machines.slice(1),
          ],
        },
      }),
    );
    await saved();
  });
  it("rejects a conflicting newer field without losing the hardware draft", async () => {
    const initial = ledger(true),
      latest = ledger(true);
    latest.hardware.machines[0].internetShareCents = 500;
    const load = vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(latest),
      mutate = vi.fn();
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    hardwareMachine();
    change("node-services internet share", "12.34");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "changed in the saved ledger",
      ),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "node-services internet share" }),
    ).toHaveValue("12.34");
  });
  it.each(["1.5", "745"])(
    "rejects invalid hardware hours %s",
    async (value) => {
      const mutate = vi.fn();
      render(
        <CostLedgerSurface
          load={vi.fn().mockResolvedValue(ledger(true))}
          mutate={mutate}
        />,
      );
      await ready();
      hardwareMachine();
      change("node-services hours per month", value);
      fireEvent.click(
        screen.getByRole("button", { name: "Save hardware assumptions" }),
      );
      expect(screen.getByRole("alert")).toBeVisible();
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it("keeps quote numeric values null and preserves dated scope and exclusions", async () => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    reference("WordPress VIP");
    fireEvent.click(screen.getByRole("button", { name: "Save comparison" }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        action: "saveComparison",
        comparison: {
          ...ledger(true).comparisons[1],
          monthlyCents: null,
          annualCents: null,
        },
      }),
    );
    await saved();
    tab("Ledger");
    expect(
      screen.getByRole("region", { name: "Saved cost totals" }),
    ).toHaveTextContent("$123.45");
  });
  it.each(["admin", "super_admin"] as const)(
    "honors canEdit=false for a %s shell",
    async (role) => {
      mocks.cmsCostLedger.mockResolvedValue(ledger(false));
      renderRoute(role);
      await ready();
      expect(screen.getByRole("button", { name: "Claude" })).toBeVisible();
      expect(
        within(
          screen.getByRole("button", { name: "Claude" }).closest("tr")!,
        ).getByText("$0.00"),
      ).toBeVisible();
      expect(
        within(
          screen
            .getByRole("button", { name: "Domain registrations" })
            .closest("tr")!,
        ).getByText("Blank"),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /^Edit .* line$/ }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "More cost actions" }),
      );
      expect(
        screen.queryByRole("menuitem", { name: "Close month" }),
      ).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Reopen month" }),
      ).toBeNull();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      tab("Price references");
      expect(screen.getByText("Quote required")).toBeVisible();
      expect(screen.queryByText("This must not render")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "View WordPress VIP reference" }),
      );
      expect(screen.queryByText("This must not render")).toBeNull();
      expect(screen.getAllByText("Quote required").length).toBeGreaterThan(1);
      tab("Hardware");
      expect(
        screen.queryByRole("button", { name: "Save hardware assumptions" }),
      ).toBeNull();
      expect(mocks.cmsCostLedger).toHaveBeenCalledExactlyOnceWith("id-token", {
        action: "view",
      });
    },
  );
  it.each([
    ["open", "Close month", "closeMonth"],
    ["closed", "Reopen month", "reopenMonth"],
  ] as const)(
    "sends the exact %s month action and period",
    async (status, label, action) => {
      const mutate = vi.fn().mockResolvedValue({ success: true });
      render(
        <CostLedgerSurface
          load={vi
            .fn()
            .mockResolvedValue(
              ledger(true, { period: "2026-08", periodStatus: status }),
            )}
          mutate={mutate}
        />,
      );
      await ready();
      menuAction(label);
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: label,
        }),
      );
      await waitFor(() =>
        expect(mutate).toHaveBeenCalledExactlyOnceWith({
          action,
          period: "2026-08",
        }),
      );
      await saved();
    },
  );
  it("saves a published dated comparison as cents with fixed exclusions", async () => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    reference("Ghost(Pro) Starter");
    expect(
      screen.queryByRole("textbox", { name: "Ghost(Pro) Starter exclusions" }),
    ).toBeNull();
    change("Ghost(Pro) Starter monthly amount", "19.25");
    fireEvent.click(screen.getByRole("button", { name: "Save comparison" }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledExactlyOnceWith({
        action: "saveComparison",
        comparison: {
          ...ledger(true).comparisons[0],
          monthlyCents: 1925,
          annualCents: 21600,
        },
      }),
    );
    await saved();
  });
  it("reports a rejected close without losing the saved ledger", async () => {
    const mutate = vi
      .fn()
      .mockRejectedValue(new Error("Sanitized close rejected."));
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    menuAction("Close month");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Close month",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Sanitized close rejected.",
      ),
    );
    expect(screen.getByRole("button", { name: "Claude" })).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Ledger month" }),
    ).toBeEnabled();
  });
  it("does not load or mutate merely because another task opens", async () => {
    const load = vi.fn().mockResolvedValue(ledger(true)),
      mutate = vi.fn();
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    for (const name of ["History", "Price references", "Hardware", "Ledger"])
      tab(name);
    expect(load).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each([undefined, ""])(
    "orders only stored, selected and supplied current months (%s)",
    async (currentPeriod) => {
      const view = ledger(true);
      view.currentPeriod = currentPeriod;
      view.periods = [
        { id: "2026-08", status: "closed" },
        { id: "2026-11", status: "open" },
      ];
      render(
        <CostLedgerSurface
          load={vi.fn().mockResolvedValue(view)}
          mutate={vi.fn()}
        />,
      );
      await ready();
      expect(
        within(screen.getByRole("combobox", { name: "Ledger month" }))
          .getAllByRole("option")
          .map((item) => (item as HTMLOptionElement).value),
      ).toEqual(["2026-08", "2026-09", "2026-11"]);
    },
  );
  it("uses the server current month and returns to it from a closed period", async () => {
    const load = vi.fn(async (period?: string) => ({
      ...ledger(true, {
        period: period ?? "2026-09",
        periodStatus: period === "2026-08" ? "closed" : "open",
      }),
      periods: [{ id: "2026-08", status: "closed" as const }],
    }));
    render(
      <CostLedgerSurface
        load={load}
        mutate={vi.fn().mockResolvedValue({ success: true })}
      />,
    );
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
      target: { value: "2026-08" },
    });
    await saved();
    expect(screen.getByRole("combobox", { name: "Ledger month" })).toHaveValue(
      "2026-08",
    );
    menuAction("Reopen month");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Reopen month",
      }),
    );
    await saved();
    fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
      target: { value: "2026-09" },
    });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("2026-09"));
  });
  it("keeps a saved-only CSV while drafts exist", async () => {
    const blob = vi.spyOn(globalThis, "Blob"),
      click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {}),
      load = vi.fn().mockResolvedValue(ledger(true));
    render(<CostLedgerSurface load={load} mutate={vi.fn()} />);
    await ready();
    fireEvent.change(await amount(), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(blob).toHaveBeenCalledWith([ledger(true).csv], {
      type: "text/csv;charset=utf-8",
    });
    expect(click.mock.contexts[0]).toHaveAttribute(
      "download",
      "cost-ledger-2026-09.csv",
    );
    expect(load).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cost-ledger"),
    );
    click.mockRestore();
    blob.mockRestore();
  });
  it.each([
    ["disabled", "Pull off"],
    ["blank", "No refresh record"],
    ["fresh", "Freshness recorded"],
    ["manual", "Not pulled"],
    ["error", "Refresh error"],
  ])(
    "uses staff-facing %s freshness text in the row and Details",
    async (status, label) => {
      const view = ledger(false);
      view.lines[0].freshnessStatus = status;
      view.lines[0].freshnessAt =
        status === "fresh" ? "2026-09-22T15:00:00.000Z" : null;
      render(
        <CostLedgerSurface
          load={vi.fn().mockResolvedValue(view)}
          mutate={vi.fn()}
        />,
      );
      const opener = await screen.findByRole("button", { name: "Claude" });
      expect(within(opener.closest("tr")!).getByText(label)).toBeVisible();
      fireEvent.click(opener);
      const facts = screen.getByRole("complementary", { name: "Line details" });
      expect(facts).toHaveTextContent(label);
      if (status === "fresh") expect(facts).toHaveTextContent("Sep 22, 2026");
      expect(within(facts).getByText("Manual")).toBeVisible();
    },
  );

  it("keeps known-zero, unknown-only and absent states distinct from source freshness", async () => {
    const view = ledger(false, { periodStatus: "closed" });
    view.lines[0].freshnessStatus = "disabled";
    view.lines[1].state = "absent";
    view.blankLineCount = 0;
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(view)}
        mutate={vi.fn()}
      />,
    );
    await ready();
    expect(document.querySelector(".cost-ledger-coverage")).toHaveTextContent(
      "0 blank",
    );
    expect(document.querySelector(".cost-ledger-coverage")).toHaveTextContent(
      "1 not included",
    );
    expect(
      screen.getByRole("complementary", { name: "Month details" }),
    ).toHaveTextContent("No amounts");
    const breakdown = screen.getByRole("complementary", {
      name: "Month details",
    });
    expect(within(breakdown).getByText("AI").closest("div")).toHaveTextContent(
      "$0.00",
    );
    expect(
      within(breakdown).getByText("Third-party services").closest("div"),
    ).toHaveTextContent("No amounts");
    expect(
      within(
        screen.getByRole("button", { name: "Claude" }).closest("tr")!,
      ).getByText("$0.00"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(
      screen.getByRole("complementary", { name: "Line details" }),
    ).toHaveTextContent("Manual");
    expect(
      screen.getByRole("complementary", { name: "Line details" }),
    ).toHaveTextContent("Pull off");
    fireEvent.click(
      screen.getByRole("button", { name: "Domain registrations" }),
    );
    expect(
      screen.getByRole("complementary", { name: "Line details" }),
    ).toHaveTextContent("Not included");
    expect(screen.queryByRole("textbox", { name: /amount for/ })).toBeNull();
  });
  it("searches notes, retains a canonical amount through dismissal, and keeps saved totals", async () => {
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={vi.fn()}
      />,
    );
    await ready();
    fireEvent.change(await amount(), { target: { value: "-12.34" } });
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    change("Search cost lines", "recorded zero");
    expect(screen.queryByRole("button", { name: "AWS S3" })).toBeNull();
    expect(await amount()).toHaveValue("-12.34");
    expect(screen.getAllByRole("textbox", { name: /amount for/ })).toHaveLength(
      1,
    );
    expect(
      screen.getByRole("region", { name: "Saved cost totals" }),
    ).toHaveTextContent("$123.45");
  });
  it("has no hardware save before setup", async () => {
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue({
          ...ledger(true),
          lines: [],
          hardware: { machines: [] },
        })}
        mutate={vi.fn()}
      />,
    );
    await ready();
    tab("Hardware");
    expect(
      screen.getByText(
        "Set up the ledger before editing hardware assumptions.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save hardware assumptions" }),
    ).toBeNull();
  });
  it("hides the route for editors", async () => {
    renderRoute("editor");
    expect(await screen.findByText("Newsroom home")).toBeVisible();
    expect(mocks.cmsCostLedger).not.toHaveBeenCalled();
  });
  it("retries an initial failed read and keeps the loading shape", async () => {
    let reject!: (error: Error) => void;
    const load = vi.fn(
      () => new Promise<CostLedgerView>((_, no) => (reject = no)),
    );
    render(<CostLedgerSurface load={load} mutate={vi.fn()} />);
    expect(
      screen.getByRole("status", { name: "Loading cost ledger" }),
    ).toBeVisible();
    await act(async () => reject(new Error("Offline")));
    expect(screen.getByRole("alert")).toHaveTextContent("Offline");
    load.mockResolvedValue(ledger(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await ready();
  });
  it("ignores an older read after the transport changes", async () => {
    let resolve!: (view: CostLedgerView) => void;
    const first = () => new Promise<CostLedgerView>((yes) => (resolve = yes)),
      mutate = vi.fn();
    const { rerender } = render(
      <CostLedgerSurface load={first} mutate={mutate} />,
    );
    rerender(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true, { period: "2026-08" }))}
        mutate={mutate}
      />,
    );
    await ready();
    await act(async () => resolve(ledger(true)));
    expect(screen.getByRole("combobox", { name: "Ledger month" })).toHaveValue(
      "2026-08",
    );
  });
  it("locks month selection and guards reload changes while keeping canceled drafts", async () => {
    const load = vi.fn().mockResolvedValue(ledger(true));
    render(
      <ExitGuardProvider>
        <CostLedgerSurface load={load} mutate={vi.fn()} />
      </ExitGuardProvider>,
    );
    await ready();
    fireEvent.change(await amount(), { target: { value: "77" } });
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
      target: { value: "2026-08" },
    });
    const month = screen.getByRole("combobox", { name: "Ledger month" });
    expect(month).toHaveAttribute("aria-disabled", "true");
    expect(month).toHaveAccessibleDescription(
      "Open · 1 pending change · save or discard first",
    );
    expect(month).toHaveValue("2026-09");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await amount()).toHaveValue("77");
    expect(load).toHaveBeenCalledTimes(1);
    menuAction("Reload saved costs");
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Discard/i }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
  it("guards a real route departure", async () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <ExitGuardProvider>
            <Link to="/away">Leave costs</Link>
            <CostLedgerSurface
              load={vi.fn().mockResolvedValue(ledger(true))}
              mutate={vi.fn()}
            />
          </ExitGuardProvider>
        ),
      },
      { path: "/away", element: <p>Other route</p> },
    ]);
    render(<RouterProvider router={router} />);
    await ready();
    fireEvent.change(await amount(), { target: { value: "77" } });
    fireEvent.click(screen.getByRole("link", { name: "Leave costs" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps read-only View labels visible in text mode", async () => {
    render(
      <ControlPresentationProvider value="text">
        <CostLedgerSurface
          load={vi.fn().mockResolvedValue(ledger(false))}
          mutate={vi.fn()}
        />
      </ControlPresentationProvider>,
    );
    await ready();
    expect(
      screen.getByRole("button", { name: "View Claude details" }),
    ).toHaveTextContent("View");
    tab("Hardware");
    expect(
      screen.getByRole("button", { name: "View node-services assumptions" }),
    ).toHaveTextContent("View");
  });
});

it("keeps a rejected month action in its explicit review while a line is selected", async () => {
  render(
    <CostLedgerSurface
      load={vi.fn().mockResolvedValue(ledger(true))}
      mutate={vi.fn().mockRejectedValue(new Error("Month action denied."))}
    />,
  );
  await ready();
  standing();
  menuAction("Close month");
  const review = screen.getByRole("dialog", { name: "Close September 2026?" });
  fireEvent.click(within(review).getByRole("button", { name: "Close month" }));
  const alert = await within(review).findByRole("alert");
  expect(alert).toHaveTextContent("Month action denied.");
  expect(alert.closest("dialog")).toBe(review);
  expect(alert.closest(".cost-ledger-inspector")).toBeNull();
});

it.each(["fresh", "intervening", "offline"] as const)(
  "recovers only hardware drafts after a %s conflict and preserves other work",
  async (kind) => {
    const initial = ledger(true);
    initial.hardware.machines[0].internetShareCents = 0;
    const latest = structuredClone(initial);
    latest.hardware.machines[0].internetShareCents = 500;
    let reads = 0,
      failNextRead = false;
    const load = vi.fn(async () => {
      if (++reads === 1) return structuredClone(initial);
      if (failNextRead) {
        failNextRead = false;
        throw new Error("Sanitized hardware read unavailable.");
      }
      return structuredClone(latest);
    });
    const mutate = vi.fn().mockResolvedValue({ success: true });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    fireEvent.change(await amount(), { target: { value: "10.50" } });
    standing();
    change("Claude notes", "Keep standing draft");
    reference();
    change("Ghost(Pro) Starter comparison notes", "Keep reference draft");
    hardwareMachine();
    change("node-services internet share", "12.34");
    if (kind === "intervening") {
      tab("Ledger");
      const form = standing();
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
      await saved();
      change("Claude notes", "Keep standing draft");
      hardwareMachine();
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    let reload = await screen.findByRole("button", {
      name: "Reload hardware assumptions",
    });
    const previousWrites = kind === "intervening" ? 1 : 0;
    expect(mutate).toHaveBeenCalledTimes(previousWrites);
    if (kind === "offline") {
      failNextRead = true;
      fireEvent.click(reload);
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Hardware assumptions could not be reloaded. All drafts remain.",
        ),
      );
      expect(
        screen.getByRole("textbox", { name: "node-services internet share" }),
      ).toHaveValue("12.34");
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        "Sanitized hardware read unavailable",
      );
      reload = screen.getByRole("button", { name: "Try again" });
      expect(
        screen.queryByRole("button", { name: "Reload hardware assumptions" }),
      ).toBeNull();
      await waitFor(() => expect(reload).toBeEnabled());
    }
    expect(document.querySelector(".cost-ledger-save-state")).toHaveTextContent(
      "4 pending changes",
    );
    fireEvent.click(reload);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "node-services internet share" }),
      ).toHaveValue("5.00"),
    );
    expect(document.querySelector(".cost-ledger-save-state")).toHaveTextContent(
      "3 pending changes",
    );
    expect(
      screen.getByRole("status", { name: "Hardware recovery" }),
    ).toHaveTextContent(
      "Hardware assumptions reloaded. Other drafts were kept.",
    );
    expect(
      screen.getAllByText(
        "Hardware assumptions reloaded. Other drafts were kept.",
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mutate).toHaveBeenCalledTimes(previousWrites);
    expect(
      screen.queryByRole("button", { name: "Reload hardware assumptions" }),
    ).toBeNull();
    tab("Ledger");
    expect(await amount()).toHaveValue("10.50");
    standing();
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Keep standing draft",
    );
    reference();
    expect(
      screen.getByRole("textbox", {
        name: "Ghost(Pro) Starter comparison notes",
      }),
    ).toHaveValue("Keep reference draft");
    hardwareMachine();
    change("node-services internet share", "12.34");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledTimes(previousWrites + 1),
    );
    expect(mutate.mock.calls.at(-1)![0]).toEqual({
      action: "saveHardware",
      hardware: {
        machines: [
          { ...latest.hardware.machines[0], internetShareCents: 1234 },
          ...latest.hardware.machines.slice(1),
        ],
      },
    });
    await saved();
  },
);

describe("Costs save coordinator", () => {
  it("validates a later reference before dispatching an earlier amount", async () => {
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    change(await amountLabel(), "10");
    reference();
    change("Ghost(Pro) Starter source URL", "http://invalid.example/");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("https address"),
    );
    expect(mutate).not.toHaveBeenCalled();
    tab("Ledger");
    expect(await amount()).toHaveValue("10");
  });
  it("rejects an oversized later payload before an earlier amount mutation", async () => {
    const view = ledger(true);
    view.comparisons[0].excludes = "界".repeat(6000);
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(view)}
        mutate={mutate}
      />,
    );
    await ready();
    change(await amountLabel(), "10");
    reference();
    change("Ghost(Pro) Starter comparison notes", "Changed reference");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("16 KiB"),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
  it("stops a partial batch, clears only confirmed scopes and retries only remaining drafts", async () => {
    const savedView = ledger(true);
    const load = vi.fn(async () => structuredClone(savedView));
    let failed = true;
    const mutate = vi.fn(async (request: any) => {
      if (request.action === "savePeriodAmount") {
        savedView.lines[0].monthlyCents = request.amountCents;
        return { success: true };
      }
      if (failed) {
        failed = false;
        throw new Error("Sanitized standing rejection.");
      }
      if (request.action === "saveLine")
        Object.assign(savedView.lines[0], request.line);
      if (request.action === "saveComparison")
        savedView.comparisons[0] = { ...request.comparison };
      return { success: true };
    });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    change(await amountLabel(), "10");
    const form = standing();
    change("Claude notes", "Standing draft");
    reference();
    change("Ghost(Pro) Starter comparison notes", "Reference draft");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Saved 1 of 3"),
    );
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent?.includes("Failed:")),
    ).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not sent: Ghost(Pro) Starter",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Costs need attention");
    expect(
      within(screen.getByRole("alert")).queryByRole("button", {
        name: "Try again",
      }),
    ).toBeNull();
    tab("Hardware");
    expect(screen.getByRole("alert")).toHaveTextContent("Costs need attention");
    hardwareMachine();
    expect(screen.getByRole("alert")).toHaveTextContent("Costs need attention");
    tab("History");
    expect(screen.getByRole("alert")).toHaveTextContent("Costs need attention");
    tab("Ledger");
    expect(await amount()).toHaveValue("10.00");
    standing();
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Standing draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(4));
    await saved();
    expect(mutate.mock.calls.map(([request]) => request.action)).toEqual([
      "savePeriodAmount",
      "saveLine",
      "saveLine",
      "saveComparison",
    ]);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
  it("distinguishes confirmed writes from reload failure and prevents duplicate submission", async () => {
    const savedView = ledger(true);
    let offline = false;
    const load = vi.fn(async () => {
      if (offline) throw new Error("Sanitized read offline.");
      return structuredClone(savedView);
    });
    const mutate = vi.fn(async (request: any) => {
      savedView.lines[0].monthlyCents = request.amountCents;
      offline = true;
      return { success: true };
    });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    change(await amountLabel(), "0");
    const form = standing();
    change("Claude notes", "Unsent standing draft");
    fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
    await waitFor(() =>
      expect(screen.getByText("Saved view needs a reload")).toBeVisible(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("write succeeded");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed and unsent drafts remain.",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Reload saved costs" }),
    ).toHaveLength(1);
    expect(screen.getByRole("alert")).not.toHaveTextContent("..");
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeDisabled();
    expect(
      screen
        .getByRole("button", { name: /^Claude amount for September 2026:/ })
        .getAttribute("aria-label"),
    ).not.toContain("pending edit");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload saved costs" }));
    await waitFor(() =>
      expect(screen.queryByText("Saved view needs a reload")).toBeNull(),
    );
    expect(
      screen.getByRole("textbox", { name: "Claude amount for September 2026" }),
    ).toHaveValue("0.00");
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Unsent standing draft",
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/Reload is required before another write/),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
  it("keeps draft-save progress idle during a recovery read after partial success", async () => {
    const savedView = ledger(true);
    let reads = 0;
    let recover!: (view: CostLedgerView) => void;
    const load = vi.fn(() => {
      reads += 1;
      if (reads === 1) return Promise.resolve(structuredClone(savedView));
      if (reads === 2)
        return Promise.reject(new Error("Sanitized reload offline."));
      return new Promise<CostLedgerView>((resolve) => {
        recover = resolve;
      });
    });
    const mutate = vi.fn(async (request: any) => {
      if (request.action === "savePeriodAmount") {
        savedView.lines[0].monthlyCents = request.amountCents;
        return { success: true };
      }
      throw new Error("Sanitized standing rejection.");
    });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    change(await amountLabel(), "10");
    standing();
    change("Claude notes", "Failed standing draft");
    reference();
    change("Ghost(Pro) Starter comparison notes", "Unsent reference draft");
    menuAction("Close month");
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes first" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByText("Saved view needs a reload"),
      ).toBeVisible(),
    );
    expect(dialog).toHaveTextContent("Saved 1 of 3");
    expect(dialog).toHaveTextContent("2 pending changes");
    expect(mutate).toHaveBeenCalledTimes(2);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reload saved costs" }),
    );
    expect(load).toHaveBeenCalledTimes(3);
    const draftSave = within(dialog).getByRole("button", {
      name: "Save changes first",
    });
    expect(draftSave).toBeDisabled();
    expect(draftSave).not.toHaveAttribute("aria-busy", "true");
    expect(within(dialog).queryByText("Saving drafts…")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Reload saved costs" }),
    ).toBeDisabled();
    expect(mutate).toHaveBeenCalledTimes(2);
    await act(async () => recover(structuredClone(savedView)));
    await waitFor(() =>
      expect(
        within(dialog).queryByText("Saved view needs a reload"),
      ).toBeNull(),
    );
    expect(dialog).toHaveTextContent("2 pending changes");
    expect(dialog).toHaveTextContent("Sanitized standing rejection.");
    expect(dialog).toHaveTextContent("Not sent:");
    expect(dialog).toHaveTextContent("Ghost(Pro) Starter");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep reviewing" }),
    );
    standing();
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Failed standing draft",
    );
    reference();
    expect(
      screen.getByRole("textbox", {
        name: "Ghost(Pro) Starter comparison notes",
      }),
    ).toHaveValue("Unsent reference draft");
    expect(mutate.mock.calls.map(([request]) => request.action)).toEqual([
      "savePeriodAmount",
      "saveLine",
    ]);
  });
  it("locks captured fields and ignores a second save until the first settles", async () => {
    let finish!: (value: unknown) => void;
    const mutate = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const load = vi.fn().mockResolvedValue(ledger(true));
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    change(await amountLabel(), "-12.34");
    const save = screen.getByRole("button", {
      name: "Save changes",
    });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const field = screen.getByRole("textbox", {
      name: "Claude amount for September 2026",
    });
    expect(field).toBeDisabled();
    fireEvent.change(field, { target: { value: "999" } });
    expect(field).toHaveValue("-12.34");
    await act(async () => finish({ success: true }));
    await saved();
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      action: "savePeriodAmount",
      lineId: "claude",
      period: "2026-09",
      amountCents: -1234,
    });
  });
  it.each(["standing", "closed"] as const)(
    "rejects known latest %s conflicts before any operation is sent",
    async (conflict) => {
      const initial = ledger(true);
      initial.lines.push({
        ...initial.lines[0],
        id: "hardware-node-services",
        label: "node-services",
        category: "hardware",
        monthlyCents: null,
        standingCents: 100,
      });
      const latest = structuredClone(initial);
      if (conflict === "standing") latest.lines.at(-1)!.standingCents = 200;
      else latest.periodStatus = "closed";
      const mutate = vi.fn(),
        load = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(latest);
      render(<CostLedgerSurface load={load} mutate={mutate} />);
      await ready();
      change(await amountLabel(), "10");
      standing("node-services");
      change("node-services notes", "Metadata draft");
      hardwareMachine();
      change("node-services internet share", "5");
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          conflict === "standing"
            ? "standing fields changed"
            : "no longer permits",
        ),
      );
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it("requires explicit review but accepts a deliberate close with blanks", async () => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    menuAction("Close month");
    const dialog = screen.getByRole("dialog");
    expect(mutate).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("Blank lines included");
    expect(dialog).toHaveTextContent(
      "scheduler completeness is a separate check",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close month" }),
    );
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledExactlyOnceWith({
        action: "closeMonth",
        period: "2026-09",
      }),
    );
  });
  it("confirms all-scope month-review discard and keeps every draft on cancel", async () => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    const load = vi.fn().mockResolvedValue(ledger(true));
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    change(await amountLabel(), "99");
    standing();
    change("Claude notes", "Retain standing draft");
    hardwareMachine();
    change("node-services watts", "222");
    reference();
    change("Ghost(Pro) Starter comparison notes", "Retain reference draft");
    menuAction("Close month");
    const review = screen.getByRole("dialog");
    expect(review).toHaveTextContent("4 pending changes");
    const discard = within(review).getByRole("button", {
      name: "Discard pending changes",
    });
    // fireEvent does not perform the browser's pointer-focus default.
    discard.focus();
    fireEvent.click(discard);
    expect(review).toHaveTextContent("4 pending changes");
    const guard = screen.getByRole("dialog", {
      name: "Discard 4 pending changes?",
    });
    expect(guard).toHaveTextContent(
      "4 unsaved changes will be removed. Saved amounts do not change.",
    );
    expect(
      within(guard).getByRole("button", { name: "Keep editing" }),
    ).toHaveFocus();
    fireEvent.click(
      within(guard).getByRole("button", { name: "Keep editing" }),
    );
    expect(discard).toHaveFocus();
    expect(review).toHaveTextContent("4 pending changes");
    fireEvent.click(
      within(review).getByRole("button", { name: "Keep reviewing" }),
    );
    expect(await amount()).toHaveValue("99");
    standing();
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Retain standing draft",
    );
    hardwareMachine();
    expect(
      screen.getByRole("textbox", { name: "node-services watts" }),
    ).toHaveValue("222");
    reference();
    expect(
      screen.getByRole("textbox", {
        name: "Ghost(Pro) Starter comparison notes",
      }),
    ).toHaveValue("Retain reference draft");
    menuAction("Close month");
    const reopened = screen.getByRole("dialog");
    fireEvent.click(
      within(reopened).getByRole("button", { name: "Discard pending changes" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Discard 4 pending changes?" }),
      ).getByRole("button", { name: "Discard changes" }),
    );
    expect(
      within(reopened).getByRole("button", { name: "Close month" }),
    ).toBeEnabled();
    expect(
      within(reopened).getByRole("button", { name: "Keep reviewing" }),
    ).toHaveFocus();
    expect(reopened).not.toHaveTextContent("pending changes");
    expect(mutate).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("blocks Reopen while standing, hardware and reference drafts survive review", async () => {
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi
          .fn()
          .mockResolvedValue(
            ledger(true, { period: "2026-08", periodStatus: "closed" }),
          )}
        mutate={mutate}
      />,
    );
    await ready();
    standing();
    change("Claude notes", "Closed-month standing draft");
    hardwareMachine();
    change("node-services watts", "222");
    reference();
    change(
      "Ghost(Pro) Starter comparison notes",
      "Closed-month reference draft",
    );
    menuAction("Reopen month");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("3 pending changes");
    const reopen = within(dialog).getByRole("button", { name: "Reopen month" });
    expect(reopen).toBeDisabled();
    fireEvent.click(reopen);
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep reviewing" }),
    );
    standing();
    expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
      "Closed-month standing draft",
    );
    hardwareMachine();
    expect(
      screen.getByRole("textbox", { name: "node-services watts" }),
    ).toHaveValue("222");
    reference();
    expect(
      screen.getByRole("textbox", {
        name: "Ghost(Pro) Starter comparison notes",
      }),
    ).toHaveValue("Closed-month reference draft");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("renders only the returned blocked reason and line IDs without claiming a close", async () => {
    const mutate = vi.fn().mockResolvedValue({
      success: true,
      changed: false,
      blocked: { reason: "stale-or-estimated", lineIds: ["aws"] },
    });
    const load = vi.fn().mockResolvedValue(ledger(true));
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    menuAction("Close month");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Close month",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Returned reason: stale-or-estimated",
      ),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Returned line IDs: aws",
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Saved 1 change/)).toBeNull();
  });
  it("replaces an earlier month block with the later retry failure", async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        changed: false,
        blocked: { reason: "stale-or-estimated", lineIds: ["aws"] },
      })
      .mockRejectedValueOnce(new Error("Permission denied for this month."));
    const load = vi.fn().mockResolvedValue(ledger(true));
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    menuAction("Close month");
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close month" }),
    );
    await waitFor(() =>
      expect(dialog).toHaveTextContent("Returned reason: stale-or-estimated"),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close month" }),
    );
    await waitFor(() =>
      expect(dialog).toHaveTextContent("Permission denied for this month."),
    );
    expect(dialog).not.toHaveTextContent("Returned reason:");
    expect(dialog).not.toHaveTextContent("Returned line IDs:");
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Saved 1 change/)).toBeNull();
  });
  it("explains that a reopened month stays open until an admin closes it", async () => {
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi
          .fn()
          .mockResolvedValue(
            ledger(true, { period: "2026-08", periodStatus: "closed" }),
          )}
        mutate={mutate}
      />,
    );
    await ready();
    menuAction("Reopen month");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "month stays open until an admin closes it again",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Reopening lets you correct amounts",
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});
async function amountLabel() {
  await amount();
  return "Claude amount for September 2026";
}

it("allows route exit and browser unload during an ordinary hanging reload", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(ledger(true))
    .mockImplementation(() => new Promise(() => {}));
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <Link to="/elsewhere">Leave Costs</Link>
          <CostLedgerSurface load={load} mutate={vi.fn()} />
        </>
      ),
    },
    { path: "/elsewhere", element: <p>Other route</p> },
  ]);
  render(
    <ExitGuardProvider>
      <RouterProvider router={router} />
    </ExitGuardProvider>,
  );
  await ready();
  menuAction("Reload saved costs");
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "Leave Costs" }));
  expect(await screen.findByText("Other route")).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("refreshes untouched hardware and reference drafts after a standing save", async () => {
  const initial = ledger(true),
    latest = ledger(true);
  Object.assign(latest.hardware.machines[0], {
    purchaseCents: 90000,
    lifeMonths: 36,
  });
  latest.comparisons[0].monthlyCents = 2200;
  const load = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(latest),
    mutate = vi.fn().mockResolvedValue({ success: true });
  render(<CostLedgerSurface load={load} mutate={mutate} />);
  await ready();
  const form = standing();
  change("Claude notes", "Standing save");
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await saved();
  hardwareMachine();
  expect(
    screen.getByRole("textbox", { name: "node-services purchase cost" }),
  ).toHaveValue("900.00");
  reference();
  expect(
    screen.getByRole("textbox", { name: "Ghost(Pro) Starter monthly amount" }),
  ).toHaveValue("22.00");
  expect(screen.queryByText(/1 pending change/)).toBeNull();
});

it.each(["independent", "conflicting"] as const)(
  "keeps hardware field provenance across an intervening standing save (%s)",
  async (changeKind) => {
    const initial = ledger(true);
    Object.assign(initial.hardware.machines[0], {
      watts: 100,
      hoursPerMonth: 100,
      centsPerKwh: 10,
      internetShareCents: 0,
    });
    const latest = structuredClone(initial);
    if (changeKind === "independent") latest.hardware.machines[0].watts = 222;
    else latest.hardware.machines[0].internetShareCents = 500;
    const load = vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(latest),
      mutate = vi.fn().mockResolvedValue({ success: true });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    hardwareMachine();
    change("node-services internet share", "12.34");
    tab("Ledger");
    const form = standing();
    change("Claude notes", "Separate standing save");
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    await saved();
    hardwareMachine();
    expect(
      screen.getByRole("textbox", { name: "node-services internet share" }),
    ).toHaveValue("12.34");
    expect(
      screen.getByRole("textbox", { name: "node-services watts" }),
    ).toHaveValue(changeKind === "independent" ? "222" : "100");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    if (changeKind === "independent") {
      await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
      expect(mutate.mock.calls[1][0]).toEqual({
        action: "saveHardware",
        hardware: {
          machines: [
            { ...latest.hardware.machines[0], internetShareCents: 1234 },
            ...latest.hardware.machines.slice(1),
          ],
        },
      });
      await saved();
    } else {
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "changed in the saved ledger",
        ),
      );
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("textbox", { name: "node-services internet share" }),
      ).toHaveValue("12.34");
    }
  },
);

it("clears explicitly discarded drafts before a hanging History month read", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(ledger(true))
    .mockImplementation(() => new Promise(() => {}));
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <Link to="/elsewhere">Leave Costs</Link>
          <CostLedgerSurface load={load} mutate={vi.fn()} />
        </>
      ),
    },
    { path: "/elsewhere", element: <p>Other route</p> },
  ]);
  render(
    <ExitGuardProvider>
      <RouterProvider router={router} />
    </ExitGuardProvider>,
  );
  await ready();
  standing();
  change("Claude notes", "Discard before read");
  tab("History");
  fireEvent.click(screen.getByRole("button", { name: "August 2026 · closed" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Discard and leave",
    }),
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "Leave Costs" }));
  expect(await screen.findByText("Other route")).toBeVisible();
});

it("refreshes an untouched automatic hardware amount after saving assumptions", async () => {
  const initial = ledger(true);
  initial.lines.push({
    ...initial.lines[1],
    id: "hardware-node-services",
    label: "node-services",
    category: "hardware",
    source: "auto",
  });
  const latest = structuredClone(initial);
  Object.assign(latest.lines.at(-1)!, { monthlyCents: 2500, state: "known" });
  Object.assign(latest.hardware.machines[0], {
    purchaseCents: 120000,
    lifeMonths: 48,
  });
  const load = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(initial)
    .mockResolvedValue(latest);
  const mutate = vi.fn().mockResolvedValue({ success: true });
  render(<CostLedgerSurface load={load} mutate={mutate} />);
  await ready();
  await openAmount("node-services");
  expect(
    screen.getByRole("textbox", {
      name: "node-services amount for September 2026",
    }),
  ).toHaveValue("");
  hardwareMachine();
  change("node-services purchase cost", "1200");
  change("node-services life months", "48");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Save hardware assumptions",
    }),
  );
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  await saved();
  tab("Ledger");
  const amount = await openAmount("node-services");
  expect(amount).toHaveValue("25.00");
  fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
  await waitFor(() =>
    expect(mutate).toHaveBeenLastCalledWith({
      action: "savePeriodAmount",
      lineId: "hardware-node-services",
      period: "2026-09",
      amountCents: 2500,
    }),
  );
  await saved();
});
it("updates the supplied current month after a period read and sorts it between stored months", async () => {
  const initial = ledger(true);
  initial.periods = [
    { id: "2026-08", status: "closed" },
    { id: "2026-11", status: "open" },
  ];
  const latest = { ...initial, period: "2026-08", currentPeriod: "2026-10" };
  render(
    <CostLedgerSurface
      load={vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(latest)}
      mutate={vi.fn()}
    />,
  );
  await ready();
  fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
    target: { value: "2026-08" },
  });
  await saved();
  expect(
    within(screen.getByRole("combobox", { name: "Ledger month" }))
      .getAllByRole("option")
      .map((e) => (e as HTMLOptionElement).value),
  ).toEqual(["2026-08", "2026-10", "2026-11"]);
});

it.each(["invalid hardware", "rejected reference"])(
  "does not offer hardware recovery for a later %s error",
  async (kind) => {
    const initial = ledger(true);
    initial.hardware.machines[0].internetShareCents = 0;
    const latest = structuredClone(initial);
    latest.hardware.machines[0].internetShareCents = 500;
    let reads = 0;
    const load = vi.fn(async () =>
      structuredClone(++reads === 1 ? initial : latest),
    );
    const mutate = vi
      .fn()
      .mockRejectedValue(new Error("Reference save unavailable."));
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    hardwareMachine();
    change("node-services internet share", "12.34");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    await screen.findByRole("button", { name: "Reload hardware assumptions" });
    if (kind === "invalid hardware") {
      change("node-services internet share", "invalid");
      fireEvent.click(
        screen.getByRole("button", { name: "Save hardware assumptions" }),
      );
    } else {
      reference();
      change("Ghost(Pro) Starter comparison notes", "Retain reference draft");
      fireEvent.click(screen.getByRole("button", { name: "Save comparison" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Reference save unavailable.",
        ),
      );
      hardwareMachine();
    }
    expect(
      screen.queryByRole("button", { name: "Reload hardware assumptions" }),
    ).toBeNull();
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "replace only hardware drafts",
    );
    expect(
      screen.getByRole("textbox", { name: "node-services internet share" }),
    ).toHaveValue(kind === "invalid hardware" ? "invalid" : "12.34");
  },
);

it("reports Month details expanded only for its visible month pane", async () => {
  render(
    <CostLedgerSurface
      load={vi.fn().mockResolvedValue(ledger(true))}
      mutate={vi.fn()}
    />,
  );
  await ready();
  const toggle = screen.getByRole("button", { name: "Month details" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("button", { name: "Claude" }));
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it.each(["amount", "standing", "reference"] as const)(
  "names the invalid %s draft when saving from another task",
  async (scope) => {
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    change(await amountLabel(), scope === "amount" ? "12.345" : "10.00");
    if (scope === "standing") {
      standing();
      change("Claude notes", "N".repeat(501));
    } else if (scope === "reference") {
      reference();
      change("Ghost(Pro) Starter comparison notes", "N".repeat(501));
    }
    tab("History");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      scope === "amount"
        ? "Claude · 2026-09 amount:"
        : scope === "standing"
          ? "Claude · standing fields:"
          : "Ghost(Pro) Starter · reference:",
    );
    expect(mutate).not.toHaveBeenCalled();
    tab("Ledger");
    expect(await amount()).toHaveValue(scope === "amount" ? "12.345" : "10.00");
  },
);

it.each(["amount", "hardware"] as const)(
  "keeps a named global %s failure available while staff navigate to repair it",
  async (scope) => {
    const initial = ledger(true);
    initial.hardware.machines[0].internetShareCents = 0;
    const latest = structuredClone(initial);
    latest.hardware.machines[0].internetShareCents = 500;
    let reads = 0;
    const load = vi.fn(async () =>
      structuredClone(++reads === 1 ? initial : latest),
    );
    const mutate = vi
      .fn()
      .mockRejectedValue(new Error("Sanitized amount rejection."));
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    if (scope === "amount") {
      change(await amountLabel(), "77");
      fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("Claude"),
      );
    } else {
      hardwareMachine();
      change("node-services internet share", "12.34");
      fireEvent.click(
        screen.getByRole("button", { name: "Save hardware assumptions" }),
      );
      await screen.findByRole("button", {
        name: "Reload hardware assumptions",
      });
    }
    const writes = mutate.mock.calls.length;
    tab("History");
    expect(screen.getByRole("alert")).toHaveTextContent(
      scope === "amount" ? "Claude" : "node-services",
    );
    reference();
    expect(screen.getByRole("alert")).toHaveTextContent(
      scope === "amount" ? "Claude" : "node-services",
    );
    if (scope === "amount") {
      tab("Ledger");
      expect(await amount()).toHaveValue("77");
    } else {
      hardwareMachine();
      expect(
        screen.getByRole("textbox", { name: "node-services internet share" }),
      ).toHaveValue("12.34");
      expect(
        screen.getByRole("button", { name: "Reload hardware assumptions" }),
      ).toBeVisible();
    }
    expect(mutate).toHaveBeenCalledTimes(writes);
  },
);

it.each(["inactive", "closed"] as const)(
  "can discard only a retained amount after its editor becomes %s",
  async (reason) => {
    let view = ledger(true);
    const load = vi.fn(async () => view);
    const mutate = vi.fn(async (request) => {
      if (request.action === "saveLine") {
        view = {
          ...view,
          periodStatus: reason === "closed" ? "closed" : "open",
          lines: view.lines.map((line) =>
            line.id === "claude"
              ? {
                  ...line,
                  notes: request.line.notes,
                  enabled: request.line.enabled,
                  state: reason === "inactive" ? "inactive" : line.state,
                  monthlyCents:
                    reason === "inactive" ? null : line.monthlyCents,
                }
              : line,
          ),
        };
      }
      return { success: true };
    });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    fireEvent.change(await amount(), { target: { value: "-12.34" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Domain registrations line" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Domain registrations notes" }),
      { target: { value: "Keep unrelated standing draft" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Claude line" }));
    if (reason === "inactive")
      fireEvent.click(screen.getByRole("checkbox", { name: "Claude active" }));
    else
      fireEvent.change(screen.getByRole("textbox", { name: "Claude notes" }), {
        target: { value: "Saved standing change" },
      });
    fireEvent.click(
      within(
        screen.getByRole("form", { name: "Claude standing line" }),
      ).getByRole("button", { name: "Save" }),
    );
    const retained = await screen.findByRole("region", {
      name: "Retained amount change",
    });
    expect(retained).toHaveTextContent("Draft amount-12.34 USD");
    expect(
      screen.getByRole("combobox", { name: "Ledger month" }),
    ).toHaveAccessibleDescription(/save or discard/i);
    expect(retained).toHaveTextContent(
      reason === "inactive" ? "Saved amountBlank" : "Saved amount0.00 USD",
    );
    expect(
      screen.queryByRole("textbox", {
        name: "Claude amount for September 2026",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Ledger month" }),
    ).toHaveAttribute("aria-disabled", "true");
    await waitFor(() =>
      expect(
        within(retained).getByRole("button", { name: "Discard amount change" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      within(retained).getByRole("button", { name: "Discard amount change" }),
    );
    expect(
      screen.queryByRole("region", { name: "Retained amount change" }),
    ).toBeNull();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close details" })).toHaveFocus();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Domain registrations line" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Domain registrations notes" }),
    ).toHaveValue("Keep unrelated standing draft");
    fireEvent.click(
      within(
        screen.getByRole("form", {
          name: "Domain registrations standing line",
        }),
      ).getByRole("button", { name: "Cancel" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Ledger month" }),
    ).toHaveAttribute("aria-disabled", "false");
  },
);

it.each(["manual", "auto"] as const)(
  "keeps historic %s amount source independent of later manual freshness",
  async (source) => {
    const view = ledger(false);
    view.period = "2026-08";
    view.periodStatus = "closed";
    const line = view.lines.find((row) => row.id === "aws-s3")!;
    line.source = source;
    line.freshnessStatus = "manual";
    line.freshnessAt = "2026-09-22T15:00:00.000Z";
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(view)}
        mutate={vi.fn()}
      />,
    );
    const opener = await screen.findByRole("button", { name: "AWS S3" });
    const row = opener.closest("tr")!;
    expect(
      within(row).getByText(source === "manual" ? "Manual" : "Automatic"),
    ).toBeVisible();
    expect(within(row).getByText("Freshness recorded")).toBeVisible();
    expect(within(row).queryByText("Not pulled")).toBeNull();
    expect(within(row).queryByText(/manual amount kept/)).toBeNull();
    fireEvent.click(opener);
    const details = screen.getByRole("complementary", { name: "Line details" });
    expect(details).toHaveTextContent("Freshness recorded · Sep 22, 2026");
    expect(details).toHaveTextContent(
      source === "manual" ? "Manual" : "Automatic",
    );
  },
);

it("keeps the initial default month pane from stealing focus in StrictMode", async () => {
  render(
    <StrictMode>
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(false))}
        mutate={vi.fn()}
      />
    </StrictMode>,
  );
  await screen.findByRole("button", { name: "AWS S3" });
  expect(
    screen.getByRole("complementary", { name: "Month details" }),
  ).toBeVisible();
  expect(document.body).toHaveFocus();
});

it("validates hardware preview bounds and groups before displaying a local amount", async () => {
  const mutate = vi.fn();
  render(
    <CostLedgerSurface
      load={vi.fn().mockResolvedValue(ledger(true))}
      mutate={mutate}
    />,
  );
  await ready();
  hardwareMachine();
  const preview = () => screen.getByText(/^Local calculation:/);
  expect(preview()).toHaveTextContent("Local calculation: Blank.");
  change("node-services purchase cost", "1200");
  expect(preview()).toHaveTextContent("Local calculation: Invalid inputs.");
  change("node-services life months", "12");
  expect(preview()).toHaveTextContent("Local calculation: $100.00.");
  change("node-services watts", "100");
  change("node-services hours per month", "745");
  change("node-services cents per kWh", "20");
  expect(preview()).toHaveTextContent("Local calculation: Invalid inputs.");
  change("node-services hours per month", "744");
  expect(preview()).toHaveTextContent("Local calculation: $114.88.");
  change("node-services purchase cost", "");
  change("node-services life months", "");
  expect(preview()).toHaveTextContent("Local calculation: $14.88.");
  change("node-services cents per kWh", "");
  expect(preview()).toHaveTextContent("Local calculation: Blank.");
  expect(mutate).not.toHaveBeenCalled();
});

it.each(["close", "reopen", "reload", "period"] as const)(
  "keeps a global %s failure outside unrelated hardware details",
  async (operation) => {
    const view = ledger(
      true,
      operation === "reopen"
        ? { period: "2026-08", periodStatus: "closed" }
        : {},
    );
    const load = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockRejectedValue(new Error("internal"));
    const mutate = vi
      .fn()
      .mockRejectedValue(
        new Error("Sanitized global hardware-context rejection."),
      );
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    hardwareMachine();
    if (operation === "period")
      fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
        target: { value: "2026-08" },
      });
    else
      menuAction(
        operation === "close"
          ? "Close month"
          : operation === "reopen"
            ? "Reopen month"
            : "Reload saved costs",
      );
    if (operation === "close" || operation === "reopen") {
      const review = screen.getByRole("dialog");
      fireEvent.click(
        within(review).getByRole("button", {
          name: operation === "close" ? "Close month" : "Reopen month",
        }),
      );
      const monthAlert = await within(review).findByRole("alert");
      expect(monthAlert).toHaveTextContent(
        "Sanitized global hardware-context rejection.",
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(
        within(
          screen.getByRole("complementary", { name: "Hardware details" }),
        ).queryByRole("alert"),
      ).toBeNull();
      fireEvent.click(
        within(review).getByRole("button", { name: "Keep reviewing" }),
      );
    }
    const alert = await screen.findByRole("alert");
    const details = screen.getByRole("complementary", {
      name: "Hardware details",
    });
    expect(within(details).queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("tabpanel", { name: "Hardware" })).toContainElement(
      alert,
    );
    if (operation === "reload" || operation === "period") {
      expect(alert).toHaveTextContent("Costs could not be loaded");
      expect(
        within(alert).getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      expect(mutate).not.toHaveBeenCalled();
    } else
      expect(alert).toHaveTextContent(
        "Sanitized global hardware-context rejection.",
      );
  },
);

it("keeps a hardware save rejection with its selected assumptions and draft", async () => {
  const mutate = vi
    .fn()
    .mockRejectedValue(new Error("Sanitized hardware save rejection."));
  render(
    <CostLedgerSurface
      load={vi.fn().mockResolvedValue(ledger(true))}
      mutate={mutate}
    />,
  );
  await ready();
  hardwareMachine();
  change("node-services watts", "100");
  fireEvent.click(
    screen.getByRole("button", { name: "Save hardware assumptions" }),
  );
  const alert = await screen.findByRole("alert");
  expect(
    screen.getByRole("complementary", { name: "Hardware details" }),
  ).toContainElement(alert);
  expect(alert).toHaveTextContent("Sanitized hardware save rejection.");
  expect(
    screen.getByRole("textbox", { name: "node-services watts" }),
  ).toHaveValue("100");
  expect(mutate).toHaveBeenCalledTimes(1);
});

it.each(["reload", "period"] as const)(
  "keeps a global %s failure outside a previously saved Ledger line",
  async (operation) => {
    const view = ledger(true);
    const load = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockResolvedValueOnce(view)
      .mockRejectedValue(new Error("internal"));
    const mutate = vi.fn().mockResolvedValue({ success: true });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    fireEvent.change(await amount(), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save amount" })).toBeEnabled(),
    );
    if (operation === "period") {
      fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
        target: { value: "2026-08" },
      });
    } else menuAction("Reload saved costs");
    const alert = await screen.findByRole("alert");
    const details = screen.getByRole("complementary", { name: "Line details" });
    expect(within(details).queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alert).toHaveTextContent("Costs could not be loaded");
    expect(alert).toHaveTextContent("The last saved view remains displayed");
    expect(
      within(alert).getByRole("button", { name: "Try again" }),
    ).toBeEnabled();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(3);
  },
);

it.each(["close", "reopen", "reload", "period"] as const)(
  "keeps a global %s failure out of an unrelated reference Inspector",
  async (operation) => {
    const view = ledger(
      true,
      operation === "reopen"
        ? { period: "2026-08", periodStatus: "closed" }
        : {},
    );
    const load = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockRejectedValue(new Error("internal"));
    const mutate = vi
      .fn()
      .mockRejectedValue(new Error("Sanitized global rejection."));
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    reference();
    if (operation === "period") {
      fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
        target: { value: "2026-08" },
      });
    } else {
      menuAction(
        operation === "close"
          ? "Close month"
          : operation === "reopen"
            ? "Reopen month"
            : "Reload saved costs",
      );
    }
    if (operation === "close" || operation === "reopen") {
      const review = screen.getByRole("dialog");
      fireEvent.click(
        within(review).getByRole("button", {
          name: operation === "close" ? "Close month" : "Reopen month",
        }),
      );
    }
    const alert = await screen.findByRole("alert");
    const details = screen.getByRole("complementary", {
      name: "Price reference details",
    });
    expect(within(details).queryByRole("alert")).toBeNull();
    expect(
      operation === "close" || operation === "reopen"
        ? screen.getByRole("dialog")
        : screen.getByRole("tabpanel", { name: "Price references" }),
    ).toContainElement(alert);
    expect(alert).not.toHaveTextContent("Ghost(Pro) Starter needs attention");
    if (operation === "reload" || operation === "period") {
      expect(alert).toHaveTextContent("Costs could not be loaded");
      expect(
        within(alert).getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      expect(mutate).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledTimes(2);
    } else {
      expect(alert).toHaveTextContent("Sanitized global rejection.");
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Keep reviewing",
        }),
      );
      const retainedAlert = screen.getByRole("alert");
      expect(within(details).queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("tabpanel", { name: "Price references" }),
      ).toContainElement(retainedAlert);
      expect(retainedAlert).toHaveTextContent("Sanitized global rejection.");
      expect(mutate).toHaveBeenCalledExactlyOnceWith({
        action: operation === "close" ? "closeMonth" : "reopenMonth",
        period: view.period,
      });
    }
  },
);

it.each([
  ["Ledger", false],
  ["History", false],
  ["Price references", false],
  ["Hardware", false],
  ["Price references", true],
  ["Hardware", true],
] as const)(
  "labels a failed view read in %s details=%s without implying a write",
  async (task, details) => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(ledger(true))
      .mockRejectedValue(new Error("internal"));
    const mutate = vi.fn();
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    if (details && task === "Hardware") hardwareMachine();
    else if (details && task === "Price references") reference();
    else tab(task);
    menuAction("Reload saved costs");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Costs could not be loaded");
    expect(alert).toHaveTextContent("The last saved view remains displayed");
    expect(alert).not.toHaveTextContent("internal");
    expect(alert).not.toHaveTextContent("could not be saved");
    expect(screen.getByRole("combobox", { name: "Ledger month" })).toHaveValue(
      "2026-09",
    );
    expect(mutate).not.toHaveBeenCalled();
  },
);

it("reports confirmed local discard even when a reload returns a server message", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(ledger(true))
    .mockRejectedValue(new Error("internal"));
  const mutate = vi.fn();
  render(
    <ExitGuardProvider>
      <CostLedgerSurface load={load} mutate={mutate} />
    </ExitGuardProvider>,
  );
  await ready();
  fireEvent.change(await amount(), { target: { value: "77" } });
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  menuAction("Reload saved costs");
  fireEvent.click(screen.getByRole("button", { name: /Discard/i }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Costs could not be loaded");
  expect(alert).toHaveTextContent(
    "Any drafts you chose to discard are already cleared",
  );
  expect(alert).not.toHaveTextContent("internal");
  // ledger(true) records Claude at zero; confirmed discard restores that saved value.
  expect(await amount()).toHaveValue("0.00");
  expect(mutate).not.toHaveBeenCalled();
});

it("keeps the prior month and labels a failed month read as a load error", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(ledger(true))
    .mockRejectedValue(new Error("internal"));
  const mutate = vi.fn();
  render(<CostLedgerSurface load={load} mutate={mutate} />);
  await ready();
  fireEvent.change(screen.getByRole("combobox", { name: "Ledger month" }), {
    target: { value: "2026-08" },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Costs could not be loaded",
  );
  expect(screen.getByRole("combobox", { name: "Ledger month" })).toHaveValue(
    "2026-09",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  expect(load).toHaveBeenLastCalledWith("2026-08");
  expect(mutate).not.toHaveBeenCalled();
});

it("retries a failed view read without exposing raw backend details or writing", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(ledger(true))
    .mockRejectedValueOnce(new Error("firebase internal backend detail"))
    .mockResolvedValue(ledger(true));
  const mutate = vi.fn();
  render(<CostLedgerSurface load={load} mutate={mutate} />);
  await ready();
  menuAction("Reload saved costs");
  const alert = await screen.findByRole("alert");
  expect(alert).not.toHaveTextContent(/firebase|backend detail|internal/i);
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("combobox", { name: "Ledger month" })).toHaveFocus();
  expect(mutate).not.toHaveBeenCalled();
});

it("guards new drafts before retrying a failed ordinary read", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(ledger(true))
    .mockRejectedValue(new Error("internal"));
  const mutate = vi.fn();
  render(
    <ExitGuardProvider>
      <CostLedgerSurface load={load} mutate={mutate} />
    </ExitGuardProvider>,
  );
  await ready();
  menuAction("Reload saved costs");
  await screen.findByRole("alert");
  fireEvent.change(await openAmount("Claude"), { target: { value: "77" } });
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(load).toHaveBeenCalledTimes(2);
  expect(await openAmount("Claude")).toHaveValue("77");
  expect(mutate).not.toHaveBeenCalled();
});

it("retries only hardware recovery while keeping another scope's draft", async () => {
  const initial = ledger(true),
    latest = ledger(true);
  latest.hardware.machines[0].internetShareCents = 500;
  const load = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(latest)
    .mockRejectedValueOnce(new Error("firebase internal"))
    .mockResolvedValue(latest);
  const mutate = vi.fn();
  render(
    <ExitGuardProvider>
      <CostLedgerSurface load={load} mutate={mutate} />
    </ExitGuardProvider>,
  );
  await ready();
  standing();
  change("Claude notes", "Keep standing draft");
  hardwareMachine();
  change("node-services internet share", "10.00");
  fireEvent.click(
    screen.getByRole("button", { name: "Save hardware assumptions" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Reload hardware assumptions" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Costs could not be loaded",
    ),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("All drafts remain");
  expect(screen.getByRole("alert")).not.toHaveTextContent(/firebase|internal/i);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "node-services internet share" }),
    ).toHaveValue("5.00"),
  );
  standing();
  expect(screen.getByRole("textbox", { name: "Claude notes" })).toHaveValue(
    "Keep standing draft",
  );
  expect(mutate).not.toHaveBeenCalled();
});

it("keeps a retained-view read error outside month review and restores its retry on return", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(ledger(true))
    .mockRejectedValue(new Error("Sanitized read unavailable."));
  const mutate = vi.fn();
  render(<CostLedgerSurface load={load} mutate={mutate} />);
  await ready();
  menuAction("Reload saved costs");
  await screen.findByRole("button", { name: "Try again" });
  menuAction("Close month");
  const review = screen.getByRole("dialog");
  expect(review).not.toHaveTextContent(
    "The requested cost view could not be loaded",
  );
  expect(within(review).queryByRole("alert")).toBeNull();
  fireEvent.click(
    within(review).getByRole("button", { name: "Keep reviewing" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Costs could not be loaded",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  expect(load).toHaveBeenCalledTimes(2);
  expect(mutate).not.toHaveBeenCalled();
});
it("shows only a new save failure from the current month review attempt", async () => {
  const mutate = vi
    .fn()
    .mockRejectedValueOnce(new Error("Earlier reference failure."))
    .mockRejectedValueOnce(new Error("Review reference failure."));
  render(
    <CostLedgerSurface
      load={vi.fn().mockResolvedValue(ledger(true))}
      mutate={mutate}
    />,
  );
  await ready();
  reference();
  change("Ghost(Pro) Starter comparison notes", "Retained reference draft");
  fireEvent.click(screen.getByRole("button", { name: "Save comparison" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Earlier reference failure.",
    ),
  );
  menuAction("Close month");
  const review = screen.getByRole("dialog");
  expect(review).not.toHaveTextContent("Earlier reference failure.");
  expect(mutate).toHaveBeenCalledTimes(1);
  fireEvent.click(
    within(review).getByRole("button", { name: "Save changes first" }),
  );
  await waitFor(() =>
    expect(review).toHaveTextContent("Review reference failure."),
  );
  expect(review).not.toHaveTextContent("Earlier reference failure.");
  expect(mutate).toHaveBeenCalledTimes(2);
});

it.each(["close", "reopen"] as const)(
  "keeps a global %s rejection outside the selected Ledger line after review closes",
  async (operation) => {
    const view = ledger(
      true,
      operation === "reopen"
        ? { period: "2026-08", periodStatus: "closed" }
        : {},
    );
    const mutate = vi
      .fn()
      .mockRejectedValue(new Error("Sanitized month rejection."));
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(view)}
        mutate={mutate}
      />,
    );
    await ready();
    standing();
    menuAction(operation === "close" ? "Close month" : "Reopen month");
    const review = screen.getByRole("dialog");
    fireEvent.click(
      within(review).getByRole("button", {
        name: operation === "close" ? "Close month" : "Reopen month",
      }),
    );
    await within(review).findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(
      within(review).getByRole("button", { name: "Keep reviewing" }),
    );
    const alert = screen.getByRole("alert");
    expect(
      within(
        screen.getByRole("complementary", { name: "Line details" }),
      ).queryByRole("alert"),
    ).toBeNull();
    expect(alert).toHaveTextContent("Sanitized month rejection.");
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      action: operation === "close" ? "closeMonth" : "reopenMonth",
      period: view.period,
    });
  },
);

it.each(
  (["Hardware", "Price references"] as const).flatMap((task) =>
    (["close", "reopen", "reload"] as const).map(
      (operation) => [task, operation] as const,
    ),
  ),
)(
  "keeps %s task errors reachable during a global %s",
  async (task, operation) => {
    const view = ledger(
      true,
      operation === "reopen"
        ? { period: "2026-08", periodStatus: "closed" }
        : {},
    );
    let rejectOperation!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockImplementation(() => pending);
    const mutate = vi.fn().mockImplementation(() => pending);
    const rendered = render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    tab(task);
    const label = task === "Hardware" ? "node-services" : "Ghost(Pro) Starter";
    const name = () => screen.getByRole("button", { name: label });
    const edit = () =>
      screen.getByRole("button", {
        name:
          task === "Hardware"
            ? `Edit ${label} assumptions`
            : `Edit ${label} reference`,
      });
    menuAction(
      operation === "close"
        ? "Close month"
        : operation === "reopen"
          ? "Reopen month"
          : "Reload saved costs",
    );
    if (operation === "close" || operation === "reopen") {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: operation === "close" ? "Close month" : "Reopen month",
        }),
      );
    }
    expect(name()).toBeDisabled();
    expect(edit()).toBeDisabled();
    fireEvent.click(name());
    fireEvent.click(edit());
    expect(
      screen.queryByRole("complementary", {
        name:
          task === "Hardware" ? "Hardware details" : "Price reference details",
      }),
    ).toBeNull();
    await act(async () =>
      rejectOperation(new Error("Sanitized global operation rejection.")),
    );
    if (operation === "close" || operation === "reopen") {
      const review = screen.getByRole("dialog");
      await within(review).findByRole("alert");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      fireEvent.click(
        within(review).getByRole("button", { name: "Keep reviewing" }),
      );
    }
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("tabpanel", { name: task })).toContainElement(
      alert,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(name()).toBeEnabled();
    expect(edit()).toBeEnabled();
    if (operation === "reload") {
      expect(
        within(alert).getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      expect(mutate).not.toHaveBeenCalled();
    } else expect(mutate).toHaveBeenCalledTimes(1);
    rendered.unmount();
  },
);

it.each(["Hardware", "Price references"] as const)(
  "keeps compact Month details closed during a global read from %s",
  async (origin) => {
    const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("73.749"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    let rendered: ReturnType<typeof render> | undefined;
    try {
      let rejectRead!: (error: Error) => void;
      const pending = new Promise<never>((_resolve, reject) => {
        rejectRead = reject;
      });
      const load = vi
        .fn()
        .mockResolvedValueOnce(ledger(true))
        .mockImplementation(() => pending);
      const mutate = vi.fn();
      rendered = render(<CostLedgerSurface load={load} mutate={mutate} />);
      await ready();
      tab(origin);
      menuAction("Reload saved costs");
      expect(screen.getByText(/Loading saved costs…/)).toHaveAttribute(
        "aria-live",
        "polite",
      );
      tab("Ledger");
      expect(
        screen.getByRole("button", { name: "Month details" }),
      ).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Month details" }));
      expect(
        screen.queryByRole("dialog", { name: "Month details" }),
      ).toBeNull();
      await act(async () => rejectRead(new Error("internal")));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Costs could not be loaded");
      expect(
        within(alert).getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("dialog", { name: "Month details" }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Month details" }),
      ).toBeEnabled();
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      rendered?.unmount();
      if (original) Object.defineProperty(window, "matchMedia", original);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  },
);

it.each([
  ["node-services watts", "1.5", "Watts"],
  ["node-services purchase cost", "1.234", "Purchase cost ($)"],
])(
  "names the malformed other-machine field %s before any hardware write",
  async (field, value, label) => {
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(ledger(true))}
        mutate={mutate}
      />,
    );
    await ready();
    hardwareMachine();
    change(field, value);
    hardwareMachine("node-compute");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`node-services: ${label}`);
    expect(mutate).not.toHaveBeenCalled();
    hardwareMachine();
    expect(screen.getByRole("textbox", { name: field })).toHaveValue(value);
  },
);

it.each(["Hardware", "Price references"] as const)(
  "returns busy %s Inspector focus to its task heading",
  async (task) => {
    let rejectRead!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce(ledger(true))
      .mockImplementation(() => pending);
    render(<CostLedgerSurface load={load} mutate={vi.fn()} />);
    await ready();
    if (task === "Hardware") hardwareMachine();
    else reference();
    menuAction("Reload saved costs");
    const close = within(
      screen.getByRole("complementary", {
        name:
          task === "Hardware" ? "Hardware details" : "Price reference details",
      }),
    ).getByRole("button", { name: "Close details" });
    close.focus();
    fireEvent.click(close);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: task })).toHaveFocus(),
    );
    await act(async () => rejectRead(new Error("internal")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Costs could not be loaded",
    );
  },
);

it.each(["close", "reopen", "reload"] as const)(
  "keeps History period links inert during a global %s",
  async (operation) => {
    let rejectOperation!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const view = ledger(
      true,
      operation === "reopen"
        ? { period: "2026-08", periodStatus: "closed" }
        : {},
    );
    const load = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockImplementation(() => pending);
    const mutate = vi.fn().mockImplementation(() => pending);
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    tab("History");
    menuAction(
      operation === "close"
        ? "Close month"
        : operation === "reopen"
          ? "Reopen month"
          : "Reload saved costs",
    );
    if (operation !== "reload")
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: operation === "close" ? "Close month" : "Reopen month",
        }),
      );
    const period = screen.getByRole("button", { name: "August 2026 · closed" });
    expect(period).toBeDisabled();
    fireEvent.click(period);
    await act(async () =>
      rejectOperation(new Error("Sanitized global History rejection.")),
    );
    if (operation !== "reload") {
      const review = screen.getByRole("dialog");
      await within(review).findByRole("alert");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      fireEvent.click(
        within(review).getByRole("button", { name: "Keep reviewing" }),
      );
    }
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(alert).toBeVisible();
    expect(load).toHaveBeenCalledTimes(operation === "reload" ? 2 : 1);
    expect(screen.getByRole("combobox", { name: "Ledger month" })).toHaveValue(
      view.period,
    );
    expect(
      screen.getByRole("button", { name: "August 2026 · closed" }),
    ).toBeEnabled();
  },
);

it("keeps compact Month details closed during a cross-task batch save", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("73.749"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  let rendered: ReturnType<typeof render> | undefined;
  try {
    let rejectWrite!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const load = vi.fn().mockResolvedValue(ledger(true));
    const mutate = vi.fn().mockImplementation(() => pending);
    rendered = render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    hardwareMachine();
    change("node-services watts", "100");
    fireEvent.click(
      screen.getByRole("button", { name: "Save hardware assumptions" }),
    );
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Hardware details" }),
      ).getByRole("button", { name: "Close details" }),
    );
    tab("Ledger");
    expect(
      screen.getByRole("button", { name: "Month details" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Month details" }));
    expect(screen.queryByRole("dialog", { name: "Month details" })).toBeNull();
    await act(async () => rejectWrite(new Error("Sanitized batch failure.")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sanitized batch failure.",
    );
    expect(screen.queryByRole("dialog", { name: "Month details" })).toBeNull();
    expect(screen.getByRole("button", { name: "Month details" })).toBeEnabled();
  } finally {
    rendered?.unmount();
    if (original) Object.defineProperty(window, "matchMedia", original);
    else Reflect.deleteProperty(window, "matchMedia");
  }
});

it("locks the month selector until a confirmed saved-view recovery completes", async () => {
  let confirmed = false,
    offline = true;
  const view = ledger(true);
  const load = vi.fn(async () => {
    if (confirmed && offline) throw new Error("Sanitized read offline.");
    return structuredClone(view);
  });
  const mutate = vi.fn(async () => {
    confirmed = true;
    view.lines[0].monthlyCents = 1200;
    return { success: true };
  });
  render(<CostLedgerSurface load={load} mutate={mutate} />);
  await ready();
  change(await amountLabel(), "12");
  fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
  await screen.findByText("Saved view needs a reload");
  expect(screen.getByRole("alert")).not.toHaveTextContent(
    "Failed and unsent drafts remain.",
  );
  const month = screen.getByRole("combobox", { name: "Ledger month" });
  expect(month).toBeDisabled();
  fireEvent.change(month, { target: { value: "2026-08" } });
  expect(load).toHaveBeenCalledTimes(2);
  expect(month).toHaveValue("2026-09");
  offline = false;
  fireEvent.click(screen.getByRole("button", { name: "Reload saved costs" }));
  await waitFor(() =>
    expect(screen.queryByText("Saved view needs a reload")).toBeNull(),
  );
  expect(month).toBeEnabled();
  expect(mutate).toHaveBeenCalledTimes(1);
});

it("announces a pending save in the existing workspace status", async () => {
  let rejectWrite!: (error: Error) => void;
  const mutate = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );
  render(
    <CostLedgerSurface
      load={vi.fn().mockResolvedValue(ledger(true))}
      mutate={mutate}
    />,
  );
  await ready();
  change(await amountLabel(), "12");
  fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  expect(
    screen.getByText(/Saving costs…/, { selector: ".cost-ledger-save-state" }),
  ).toHaveAttribute("aria-live", "polite");
  await act(async () => rejectWrite(new Error("Sanitized save failure.")));
  expect(screen.queryByText(/Saving costs…/)).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sanitized save failure.",
  );
});

it.each(["Ledger", "History", "Price references", "Hardware"] as const)(
  "keeps %s recovery focus on a stable task heading after its button disappears",
  async (task) => {
    let confirmed = false,
      offline = true;
    const server = ledger(true);
    const load = vi.fn(async () => {
      if (confirmed && offline) throw new Error("Sanitized read unavailable.");
      return structuredClone(server);
    });
    const mutate = vi.fn(async () => {
      confirmed = true;
      server.lines[0].monthlyCents = 1200;
      return { success: true };
    });
    render(<CostLedgerSurface load={load} mutate={mutate} />);
    await ready();
    change(await amountLabel(), "12");
    fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
    await within(await screen.findByRole("alert")).findByText(
      "Saved view needs a reload",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    tab(task);
    const heading = screen.getByRole("heading", {
      name: task === "Ledger" ? "Cost lines" : task,
    });
    const retry = within(screen.getByRole("alert")).getByRole("button", {
      name: "Reload saved costs",
    });
    retry.focus();
    offline = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(heading).toHaveFocus();
    expect(mutate).toHaveBeenCalledTimes(1);
  },
);

it.each(["amount", "standing", "reference"] as const)(
  "keeps a rejected individual %s save out of unrelated editors",
  async (scope) => {
    const view = ledger(true),
      first = view.comparisons[0],
      other = view.comparisons[1];
    const mutate = vi
      .fn()
      .mockRejectedValue(new Error("Sanitized individual rejection."));
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(view)}
        mutate={mutate}
      />,
    );
    await ready();
    if (scope === "amount") {
      change(await amountLabel(), "12");
      fireEvent.click(screen.getByRole("button", { name: "Save amount" }));
    } else if (scope === "standing") {
      const form = standing();
      change("Claude notes", "Retained single draft");
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    } else {
      reference(first.product);
      change(`${first.product} comparison notes`, "Retained single reference");
      fireEvent.click(screen.getByRole("button", { name: "Save comparison" }));
    }
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      scope === "reference" ? first.product : "Claude",
    );
    expect(alert.closest(".cost-ledger-inspector")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    if (scope === "reference") reference(other.product);
    else standing("Domain registrations");
    expect(
      screen.getByRole("alert").closest(".cost-ledger-inspector"),
    ).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sanitized individual rejection.",
    );
    if (scope === "reference") standing();
    else reference(first.product);
    expect(
      screen.getByRole("alert").closest(".cost-ledger-inspector"),
    ).toBeNull();
    if (scope === "reference") reference(first.product);
    else standing();
    expect(
      screen.getByRole("alert").closest(".cost-ledger-inspector"),
    ).not.toBeNull();
    expect(mutate).toHaveBeenCalledTimes(1);
  },
);

it.each(
  (["close", "reopen"] as const).flatMap((action) =>
    [0, 1].map((known) => [action, known] as const),
  ),
)(
  "keeps the %s review honest when zero has %s known lines",
  async (action, known) => {
    const view = ledger(
      true,
      action === "reopen" ? { period: "2026-08", periodStatus: "closed" } : {},
    );
    view.monthlyCents = 0;
    view.knownLineCount = known;
    if (!known) {
      view.lines = view.lines.map((line) => ({
        ...line,
        enabled: true,
        state: "blank",
        monthlyCents: null,
      }));
      view.blankLineCount = view.lines.length;
    }
    const mutate = vi.fn();
    render(
      <CostLedgerSurface
        load={vi.fn().mockResolvedValue(view)}
        mutate={mutate}
      />,
    );
    await ready();
    menuAction(action === "close" ? "Close month" : "Reopen month");
    const review = screen.getByRole("dialog");
    expect(
      within(review).getByText("Saved known total").nextElementSibling,
    ).toHaveTextContent(known ? "$0.00" : "No amounts");
    expect(mutate).not.toHaveBeenCalled();
  },
);
