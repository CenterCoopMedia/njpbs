import { describe, expect, it } from "vitest";
import {
  authReducer,
  type AuthState,
} from "../src/context/authReducer";
import type { Principal } from "../../packages/content-core/src/rbac";

const principal: Principal = { id: "u1", grants: [{ role: "admin" }] };
const user = { uid: "u1", email: "admin@example.com", displayName: "Admin" };
const userDoc = {
  email: "admin@example.com",
  role: "admin" as const,
  grants: [],
  displayName: "Admin",
};

describe("auth reducer", () => {
  it("records the admission stage the wait is in", () => {
    expect(
      authReducer(
        { status: "loading", stage: "session" },
        { type: "loading", stage: "admission" },
      ),
    ).toEqual({ status: "loading", stage: "admission" });
  });

  it("moves from loading to signed out", () => {
    const state = authReducer({ status: "loading", stage: "session" }, { type: "signed-out" });

    expect(state).toEqual({ status: "signed-out" });
  });

  it("keeps an unverified account available for the email step", () => {
    expect(
      authReducer(
        { status: "loading", stage: "session" },
        { type: "email-unverified", user: { ...user, emailVerified: false } },
      ),
    ).toEqual({
      status: "email-unverified",
      user: { ...user, emailVerified: false },
    });
  });

  it("moves from loading or signed out to signed in", () => {
    const action = { type: "signed-in" as const, user, principal, userDoc };

    expect(authReducer({ status: "loading", stage: "session" }, action)).toEqual({
      status: "signed-in",
      user,
      principal,
      userDoc,
    });
    expect(authReducer({ status: "signed-out" }, action)).toEqual({
      status: "signed-in",
      user,
      principal,
      userDoc,
    });
  });

  it("moves any state to error", () => {
    const error = new Error("Profile load failed");
    const states: AuthState[] = [
      { status: "loading", stage: "session" },
      { status: "signed-out" },
      { status: "signed-in", user, principal, userDoc },
    ];

    for (const state of states) {
      expect(authReducer(state, { type: "error", error })).toEqual({
        status: "error",
        error,
      });
    }
  });

  it("moves signed in to signed out", () => {
    const state = authReducer(
      { status: "signed-in", user, principal, userDoc },
      { type: "signed-out" },
    );

    expect(state).toEqual({ status: "signed-out" });
  });
});
