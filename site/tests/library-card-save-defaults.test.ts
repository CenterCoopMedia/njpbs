import { describe, expect, it } from "vitest";
import publication from "../../functions/lib/library-card-publication.js";
import formDefaults from "../../packages/content-core/fixtures/library-card-form-defaults.json";
import { exportRecordCards } from "../src/lib/record-card-resolution";

const now = new Date("2026-10-08T12:00:00.000Z");
const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Station news" }] }] };
const records = {
  sponsor: { id: "sponsor", type: "sponsor", name: "Station sponsor", href: "https://example.test/" },
  newsletter: { id: "newsletter", type: "newsletter", title: "Station newsletter", signupUrl: "https://example.test/join", body },
};
// Admin's matching test checks these fixtures against the real field defaults.
const hydrated = <T extends Record<string, unknown> & { id: string }>(kind: keyof typeof records, record: T) => ({
  ...formDefaults[kind],
  ...record,
});
const { changesPublicLibraryFields } = publication;

describe("library save defaults at the Admin/server boundary", () => {
  it.each(["sponsor", "newsletter"] as const)("admits the real %s form defaults on an unrelated contributor save", kind => {
    const stored = records[kind];
    const composed = { ...hydrated(kind, stored), publishAt: "2026-10-09T12:00:00.000Z" };
    expect(exportRecordCards([composed], [], now)).toEqual(exportRecordCards([stored], [], now));
    expect(changesPublicLibraryFields(stored, composed)).toBe(false);
  });

  it.each(["sponsor", "newsletter"] as const)("admits a %s restore that removes empty optional form defaults", kind => {
    const current = hydrated(kind, records[kind]);
    const restored = records[kind];
    expect(exportRecordCards([current], [], now)).toEqual(exportRecordCards([restored], [], now));
    expect(changesPublicLibraryFields(current, restored)).toBe(false);
  });

  it("admits the form's empty body for a legacy newsletter without a body", () => {
    const { body: _body, ...stored } = records.newsletter;
    const composed = hydrated("newsletter", stored);
    expect(exportRecordCards([composed], [], now)).toEqual(exportRecordCards([stored], [], now));
    expect(changesPublicLibraryFields(stored, composed)).toBe(false);
    expect(changesPublicLibraryFields(composed, stored)).toBe(false);
  });

  it.each([
    ["sponsor", { name: "Changed sponsor" }], ["sponsor", { href: "https://changed.example.test/" }],
    ["sponsor", { logoAssetId: "new-art" }], ["sponsor", { logoAlt: "New logo" }],
    ["sponsor", { logoDecorative: true }], ["sponsor", { tier: "Partner" }],
    ["sponsor", { description: "New description" }], ["sponsor", { activeFrom: "2026-10-09" }],
    ["sponsor", { activeUntil: "2026-10-07" }], ["newsletter", { title: "Changed newsletter" }],
    ["newsletter", { signupUrl: "https://changed.example.test/join" }], ["newsletter", { frequency: "Weekly" }],
    ["newsletter", { summary: "New summary" }], ["newsletter", { imageAssetId: "new-art" }],
    ["newsletter", { imageAlt: "New illustration" }], ["newsletter", { imageDecorative: true }],
    ["newsletter", { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Changed summary" }] }] } }],
  ] as const)("still requires publication permission for %s fields: %j", (kind, change) => {
    const stored = records[kind];
    expect(changesPublicLibraryFields(stored, { ...hydrated(kind, stored), ...change })).toBe(true);
  });

  it.each(["sponsor", "newsletter"] as const)("still gates clearing a %s public field and creating its card", kind => {
    const current = { ...records[kind], ...(kind === "sponsor" ? { description: "Public description" } : { summary: "Public summary" }) };
    const cleared = { ...current, ...(kind === "sponsor" ? { description: "" } : { summary: "" }) };
    expect(changesPublicLibraryFields(current, cleared)).toBe(true);
    expect(changesPublicLibraryFields(undefined, records[kind])).toBe(true);
  });

  it.each(["sponsor", "newsletter"] as const)("keeps the server-owned %s visibility change privileged", kind => {
    const stored = { ...records[kind], publiclyVisible: true };
    expect(changesPublicLibraryFields(stored, { ...stored, publiclyVisible: false })).toBe(true);
  });
});
