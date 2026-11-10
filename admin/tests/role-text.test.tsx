import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ALL_CAPABILITIES, hasCapability } from "../../packages/content-core/src/rbac";
import { UsersTable } from "../src/components/UsersTable";
import { principalFromUserDoc } from "../src/lib/principal";
describe("staff role words", () => {
  it.each(["unknown-role", "toString", "__proto__"])("keeps the roster readable and denies access for %s", (role) => {
    const user = { id: "person", grants: [{ role, sections: ["watch"] }] };
    render(<UsersTable users={[user]} canManage={false} onGrant={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText(`Unknown role (${role})`)).toBeVisible();
    const principal = principalFromUserDoc("person", user);
    for (const capability of ALL_CAPABILITIES) expect(hasCapability(principal, capability)).toBe(false);
  });
});
