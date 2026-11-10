import { describe, expect, it, vi } from "vitest";
import github from "../../functions/bug-report-github.js";

const NOW = new Date("2026-08-29T00:00:00.000Z");

function req(body = {}) {
  return { method: "POST", body, headers: {}, ip: "203.0.113.20" };
}

function res() {
  const result = { statusCode: null, body: null, headers: {} };
  result.status = (status) => { result.statusCode = status; return result; };
  result.json = (body) => { result.body = body; return result; };
  result.set = (name, value) => { result.headers[name.toLowerCase()] = value; return result; };
  return result;
}

function githubPrincipal(role = "admin") {
  return {
    uid: `${role}-1`,
    email: `${role}@example.org`,
    emailVerified: true,
    principal: { id: `${role}-1`, grants: [{ role }] },
  };
}

describe("GitHub issue list for Admin reports", () => {
  it("lists repository issues and drops pull requests", async () => {
    const handler = github.createCmsListGithubIssuesHandler({
      requirePrincipalFn: async () => githubPrincipal(),
      isAdminFn: async () => true,
      createClient: () => ({
        listIssuesByState: vi.fn(async () => [
          {
            number: 1966,
            title: "Tighten columns",
            state: "open",
            html_url: "https://github.com/example-owner/private-reports/issues/1966",
            updated_at: NOW.toISOString(),
            created_at: NOW.toISOString(),
            comments: 2,
            labels: [{ name: "type:bug" }],
            user: { login: "fixture-user" },
          },
          {
            number: 2001,
            title: "A pull request",
            state: "open",
            html_url: "https://github.com/example-owner/private-reports/pull/2001",
            pull_request: { url: "https://api.github.com/repos/example-owner/private-reports/pulls/2001" },
          },
        ]),
      }),
    });
    const response = res();

    await handler(req({ state: "open" }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.issues).toEqual([
      expect.objectContaining({
        number: 1966,
        title: "Tighten columns",
        state: "open",
        commentCount: 2,
        labels: ["type:bug"],
      }),
    ]);
    expect(response.body.truncated).toBe(false);
  });

  it("keeps fetching GitHub pages until the issue window is full", async () => {
    const pull = {
      number: 2001,
      title: "A pull request",
      state: "open",
      html_url: "https://github.com/example-owner/private-reports/pull/2001",
      pull_request: { url: "https://api.github.com/repos/example-owner/private-reports/pulls/2001" },
    };
    const listIssuesByState = vi.fn(async (_state, page) => {
      if (page === 1) return Array.from({ length: 100 }, () => pull);
      return [{
        number: 1966,
        title: "Tighten columns",
        state: "open",
        html_url: "https://github.com/example-owner/private-reports/issues/1966",
        updated_at: NOW.toISOString(),
        created_at: NOW.toISOString(),
        comments: 0,
        labels: [],
        user: { login: "fixture-user" },
      }];
    });
    const handler = github.createCmsListGithubIssuesHandler({
      requirePrincipalFn: async () => githubPrincipal(),
      isAdminFn: async () => true,
      createClient: () => ({ listIssuesByState }),
    });
    const response = res();

    await handler(req({ state: "open" }), response);

    expect(response.statusCode).toBe(200);
    expect(listIssuesByState).toHaveBeenCalledTimes(2);
    expect(response.body.issues).toEqual([
      expect.objectContaining({ number: 1966, title: "Tighten columns" }),
    ]);
  });

  it("returns an issue description and comments", async () => {
    const handler = github.createCmsGetGithubIssueHandler({
      requirePrincipalFn: async () => githubPrincipal(),
      isAdminFn: async () => true,
      createClient: () => ({
        getIssue: vi.fn(async () => ({
          number: 1966,
          title: "Tighten columns",
          state: "open",
          html_url: "https://github.com/example-owner/private-reports/issues/1966",
          updated_at: NOW.toISOString(),
          created_at: NOW.toISOString(),
          comments: 1,
          body: "The columns need to line up.",
          user: { login: "fixture-user" },
          labels: [],
        })),
        listIssueComments: vi.fn(async () => ([
          {
            id: 44,
            user: { login: "editor" },
            created_at: NOW.toISOString(),
            body: "Still happening.",
          },
        ])),
      }),
    });
    const response = res();

    await handler(req({ number: 1966 }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.issue.body).toBe("The columns need to line up.");
    expect(response.body.issue.comments).toEqual([
      expect.objectContaining({ id: 44, author: "editor", body: "Still happening." }),
    ]);
  });

  it("refuses a GitHub issue list to a non-admin", async () => {
    const handler = github.createCmsListGithubIssuesHandler({
      requirePrincipalFn: async () => githubPrincipal("editor"),
      isAdminFn: async () => false,
      createClient: () => ({ listIssuesByState: vi.fn() }),
    });
    const response = res();

    await handler(req({ state: "open" }), response);

    expect(response.statusCode).toBe(403);
    expect(response.body.error).toMatch(/admin access required/i);
  });
});
