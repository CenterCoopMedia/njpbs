const AUTHOR_ID = /^au_[0-9a-f]{32}$/;
const MAX_ROWS = 200;
const MAX_RESPONSE_BYTES = 256 * 1024;

interface BylineAuthor {
  authorId: string;
  displayName: string;
  jobTitle: string | null;
  profileReadiness: {
    hasPhoto: boolean;
    hasJobTitle: boolean;
    hasBio: boolean;
    published: boolean;
  };
}

interface BylineResponse {
  apiVersion: 1;
  success: true;
  authors: BylineAuthor[];
  nextCursor: string | null;
  selfAuthorId: string | null;
}

interface BylineRequest {
  token: string;
  uid: string;
  authTime: number;
  apiKey: string;
  projectId: string;
  body: ArrayBuffer;
  fetcher: typeof fetch;
  onStage?: (stage: "account_lookup" | "staff_account" | "projection_fetch" | "projection_decode") => void;
}

const FAILURE_REASONS = new Map([
  ["Invalid byline request", "request_invalid"],
  ["Invalid byline cursor", "cursor_invalid"],
  ["Account lookup failed", "account_lookup_rejected"],
  ["Account is unavailable", "account_unavailable"],
  ["CMS account is unavailable", "staff_account_rejected"],
  ["CMS account is inactive", "staff_account_inactive"],
  ["Invalid CMS account", "staff_account_invalid"],
  ["Byline projection is unavailable", "projection_rejected"],
  ["Invalid byline document", "projection_document_invalid"],
  ["Invalid byline document name", "projection_document_name_invalid"],
  ["Invalid byline eligibility", "projection_eligibility_invalid"],
  ["Invalid byline query", "projection_query_invalid"],
  ["Byline query exceeded limit", "projection_limit_exceeded"],
  ["Invalid byline fields", "projection_fields_invalid"],
  ["Invalid byline author id", "projection_author_invalid"],
  ["Invalid self author id", "self_author_invalid"],
  ["Google response has no body", "response_empty"],
  ["Google response is too large", "response_too_large"],
]);

export function bylineFailureReason(error: unknown): string {
  // Never send arbitrary exception text, Google bodies, tokens or URLs to logs.
  return FAILURE_REASONS.get(error instanceof Error ? error.message : "") ?? "unexpected";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Google response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Google response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function requestPage(body: ArrayBuffer): { limit: number; startAfter: string | null } {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!record(parsed)) throw new Error("Invalid byline request");
  const limit = Number.isSafeInteger(parsed.limit)
    ? Math.min(Math.max(Number(parsed.limit), 1), MAX_ROWS)
    : MAX_ROWS;
  const startAfter = typeof parsed.startAfter === "string" && parsed.startAfter.length > 0
    ? parsed.startAfter : null;
  if (startAfter && !AUTHOR_ID.test(startAfter)) throw new Error("Invalid byline cursor");
  return { limit, startAfter };
}

function documentFields(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.fields)) throw new Error("Invalid byline document");
  return value.fields;
}

function stringField(value: unknown): string | null {
  return record(value) && typeof value.stringValue === "string" ? value.stringValue : null;
}

function bylineRow(value: unknown, prefix: string): { id: string; author: BylineAuthor | null } {
  if (!record(value) || typeof value.name !== "string" || !value.name.startsWith(prefix)) {
    throw new Error("Invalid byline document name");
  }
  const id = value.name.slice(prefix.length);
  if (!AUTHOR_ID.test(id)) throw new Error("Invalid byline author id");
  const fields = documentFields(value);
  if (stringField(fields.authorId) !== id) throw new Error("Invalid byline author id");
  const eligible = record(fields.eligible) ? fields.eligible.booleanValue : undefined;
  if (eligible === false) return { id, author: null };
  if (eligible !== true) throw new Error("Invalid byline eligibility");
  const displayName = stringField(fields.displayName);
  const jobTitle = stringField(fields.jobTitle);
  const nullJobTitle = record(fields.jobTitle) && "nullValue" in fields.jobTitle;
  if (displayName === null || (jobTitle === null && !nullJobTitle)) {
    throw new Error("Invalid byline fields");
  }
  const readiness = record(fields.profileReadiness) && record(fields.profileReadiness.mapValue)
    ? fields.profileReadiness.mapValue.fields : null;
  if (!record(readiness)) throw new Error("Invalid byline fields");
  const profileReadiness = {} as BylineAuthor["profileReadiness"];
  for (const key of ["hasPhoto", "hasJobTitle", "hasBio", "published"] as const) {
    const value = record(readiness[key]) ? readiness[key].booleanValue : undefined;
    if (typeof value !== "boolean") throw new Error("Invalid byline fields");
    profileReadiness[key] = value;
  }
  return { id, author: { authorId: id, displayName, jobTitle, profileReadiness } };
}

function selfAuthorId(value: unknown): string | null {
  const fields = documentFields(value);
  const id = stringField(fields.authorId);
  if (!id || !AUTHOR_ID.test(id)) throw new Error("Invalid self author id");
  return id;
}

export async function readBylineDirectory(input: BylineRequest): Promise<BylineResponse> {
  // Native Worker fetch rejects unrelated objects as its JavaScript receiver.
  const fetcher = input.fetcher;
  const { limit, startAfter } = requestPage(input.body);
  const root = `projects/${input.projectId}/databases/(default)/documents`;
  const authHeaders = { authorization: `Bearer ${input.token}` };

  input.onStage?.("account_lookup");
  const lookup = await fetcher(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(input.apiKey)}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: input.token }), redirect: "manual" },
  );
  if (!lookup.ok) throw new Error("Account lookup failed");
  const accountInfo = await boundedJson(lookup);
  const users = record(accountInfo) ? accountInfo.users : null;
  const account = Array.isArray(users) && users.length === 1 ? users[0] : null;
  if (!record(account) || account.localId !== input.uid || account.disabled === true ||
      (account.validSince !== undefined &&
        (!/^\d+$/.test(String(account.validSince)) || input.authTime < Number(account.validSince)))) {
    throw new Error("Account is unavailable");
  }

  input.onStage?.("staff_account");
  const ownAccount = await fetcher(
    `https://firestore.googleapis.com/v1/${root}/users/${encodeURIComponent(input.uid)}?mask.fieldPaths=active`,
    { headers: authHeaders, redirect: "manual" },
  );
  if (!ownAccount.ok) throw new Error("CMS account is unavailable");
  const accountDocument = await boundedJson(ownAccount);
  if (!record(accountDocument) ||
      (accountDocument.fields !== undefined && !record(accountDocument.fields))) {
    throw new Error("Invalid CMS account");
  }
  const accountFields = record(accountDocument.fields) ? accountDocument.fields : {};
  if (record(accountFields.active) && accountFields.active.booleanValue === false) {
    throw new Error("CMS account is inactive");
  }

  const cursor = startAfter ? {
    startAt: {
      values: [{ referenceValue: `${root}/cmsBylineDirectory/${startAfter}` }],
      before: false,
    },
  } : {};
  input.onStage?.("projection_fetch");
  const query = fetcher(`https://firestore.googleapis.com/v1/${root}:runQuery`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "cmsBylineDirectory" }],
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit,
      ...cursor,
    } }),
    redirect: "manual",
  });
  const self = fetcher(
    `https://firestore.googleapis.com/v1/${root}/cmsBylineSelf/${encodeURIComponent(input.uid)}`,
    { headers: authHeaders, redirect: "manual" },
  );
  const [queryResponse, selfResponse] = await Promise.all([query, self]);
  if (!queryResponse.ok || (selfResponse.status !== 404 && !selfResponse.ok)) {
    await Promise.all([queryResponse.body?.cancel(), selfResponse.body?.cancel()]);
    throw new Error("Byline projection is unavailable");
  }
  input.onStage?.("projection_decode");
  const [queryValue, selfValue] = await Promise.all([
    boundedJson(queryResponse),
    selfResponse.status === 404 ? null : boundedJson(selfResponse),
  ]);
  if (!Array.isArray(queryValue)) throw new Error("Invalid byline query");
  const prefix = `${root}/cmsBylineDirectory/`;
  const rows = queryValue.filter((item) => record(item) && item.document !== undefined)
    .map((item) => bylineRow((item as Record<string, unknown>).document, prefix));
  if (rows.length > limit) throw new Error("Byline query exceeded limit");
  const authors = rows.flatMap((row) => row.author ? [row.author] : []);
  authors.sort((left, right) => left.displayName.localeCompare(right.displayName));
  return {
    apiVersion: 1,
    success: true,
    authors,
    nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
    selfAuthorId: selfValue === null ? null : selfAuthorId(selfValue),
  };
}
