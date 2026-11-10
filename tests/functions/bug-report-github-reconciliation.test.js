import { describe, expect, it } from "vitest";
import github from "../../functions/bug-report-github.js";

const REPOSITORY = "example-owner/private-reports";
const REPORT = {
  id: "br_" + "d".repeat(32),
  createdAt: "2026-08-29T00:00:00.000Z",
  happened: "The draft did not save.",
  severity: "minor",
  area: "content_editing",
};
const AUTHOR = { id: 1000001, login: "example-author" };

function issue(number, user, overrides = {}) {
  return {
    number,
    user,
    html_url: `https://github.com/${REPOSITORY}/issues/${number}`,
    title: "CMS report",
    body: `<!-- njpbs-cms-report: ${REPORT.id} -->`,
    state: "open",
    created_at: REPORT.createdAt,
    updated_at: REPORT.createdAt,
    ...overrides,
  };
}

function api({ pages, identity = AUTHOR, identityStatus = 200 }) {
  const writes = [];
  const client = github.createGithubClient({
    token: "test-token-value",
    repository: REPOSITORY,
    fetchFn: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/user" && init.method === "GET") {
        return Response.json(identity, { status: identityStatus });
      }
      if (url.pathname === `/repos/${REPOSITORY}/issues`) {
        if (init.method === "POST") {
          const body = JSON.parse(init.body);
          writes.push({ method: init.method, path: url.pathname, body });
          return Response.json(issue(1500, AUTHOR, body), { status: 201 });
        }
        if (url.searchParams.get("state") === "open") return Response.json([]);
        return Response.json(pages[Number(url.searchParams.get("page")) - 1] ?? []);
      }
      throw new Error(`Unexpected test request: ${init.method} ${url.pathname}`);
    },
  });
  return { client, writes };
}

function execute(client) {
  return github.executeGithubOperation({
    operation: "create_issue_and_fix",
    record: REPORT,
  }, client);
}

describe("GitHub report reconciliation at the API boundary", () => {
  it.each([
    ["a different account", { id: 42, login: "other-author" }],
    ["a copied login with a different ID", { id: 42, login: AUTHOR.login }],
    ["a missing author", undefined],
    ["a string author ID", { id: String(AUTHOR.id), login: AUTHOR.login }],
  ])("creates its own issue when the report marker belongs to %s", async (_name, user) => {
    const { client, writes } = api({ pages: [[issue(1400, user)]] });

    const result = await execute(client);

    expect(result.issueSelection).toBe("created");
    expect(result.issues.map(({ number }) => number)).toEqual([1500]);
    expect(writes).toEqual([{
      method: "POST",
      path: `/repos/${REPOSITORY}/issues`,
      body: expect.objectContaining({ body: expect.stringContaining(REPORT.id) }),
    }]);
  });

  it("recovers an issue written by the token owner even after a login change", async () => {
    const { client, writes } = api({ pages: [[
      issue(1400, { id: AUTHOR.id, login: "previous-login" }),
    ]] });

    const result = await execute(client);

    expect(result.issueSelection).toBe("reconciled");
    expect(result.issues.map(({ number }) => number)).toEqual([1400]);
    expect(writes).toEqual([]);
  });

  it("continues past a forged marker to recover the real issue on the next page", async () => {
    const firstPage = [issue(1400, { id: 42 }), ...Array.from({ length: 99 },
      (_, index) => issue(index + 1, AUTHOR, { body: "Unrelated issue" }))];
    const { client, writes } = api({ pages: [firstPage, [issue(1401, AUTHOR)]] });

    const result = await execute(client);

    expect(result.issueSelection).toBe("reconciled");
    expect(result.issues.map(({ number }) => number)).toEqual([1401]);
    expect(writes).toEqual([]);
  });

  it("does not recover a pull request with the report marker", async () => {
    const { client, writes } = api({ pages: [[issue(1400, AUTHOR, {
      pull_request: { url: `https://api.github.com/repos/${REPOSITORY}/pulls/1400` },
    })]] });

    const result = await execute(client);

    expect(result.issueSelection).toBe("created");
    expect(result.issues.map(({ number }) => number)).toEqual([1500]);
    expect(writes).toHaveLength(1);
  });

  it("stops without a write when the authenticated identity read fails", async () => {
    const { client, writes } = api({
      pages: [[issue(1400, AUTHOR)]],
      identity: { message: "Unavailable" },
      identityStatus: 503,
    });

    await expect(execute(client)).rejects.toMatchObject({ kind: "retryable", status: 503 });
    expect(writes).toEqual([]);
  });

  it.each([{}, { id: 0 }, { id: String(AUTHOR.id) }])(
    "stops without a write for an invalid authenticated identity %j",
    async (identity) => {
      const { client, writes } = api({ pages: [[issue(1400, AUTHOR)]], identity });

      await expect(execute(client)).rejects.toMatchObject({ kind: "terminal" });
      expect(writes).toEqual([]);
    },
  );
});
