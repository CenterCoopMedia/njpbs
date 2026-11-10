import { describe, expect, it } from "vitest";
import { displayValue, matchesSearch, normalSearch, parsePoliticsResource, partyCounts, safeSourceUrl } from "../src/lib/politics-resource";
import source from "./fixtures/resources/nj-politics.json";
describe("politics resource data contract", () => {
  it("retains every section and role status in a synthetic workbook", () => {
    const data = parsePoliticsResource(source);
    expect(data.people).toHaveLength(2);
    expect(data.sections).toHaveLength(6);
    expect(data.meta.researchAsOf).toBe("2026-09-01");
    expect(data.meta.lastTargetedUpdate).toBe("2026-09-26");
    expect(data.people.find(p => p.name.includes("Example"))?.role).toMatch(/Acting/i);
    expect(data.people.find(p => p.name.includes("Sample"))?.role).toMatch(/former/i);
  });
  it("computes chamber counts from records rather than fixed numbers", () => {
    const data = parsePoliticsResource(source);
    expect(partyCounts(data.sections.find(s => s.id === "federal-delegation")!, "U.S. House")).toEqual([{ party: "D", count: 1 }, { party: "R", count: 1 }]);
    expect(partyCounts(data.sections.find(s => s.id === "state-senate")!)).toEqual([{ party: "D", count: 1 }, { party: "R", count: 1 }]);
    expect(partyCounts(data.sections.find(s => s.id === "general-assembly")!)).toEqual([{ party: "D", count: 2 }, { party: "R", count: 1 }]);
  });
  it("rejects malformed and duplicate records", () => {
    expect(() => parsePoliticsResource({})).toThrow();
    expect(() => parsePoliticsResource({ ...source, people: [source.people[0], source.people[0]] })).toThrow();
    const sections = [{ ...source.sections[0], records: [source.sections[0].records[0], source.sections[0].records[0]] }];
    expect(() => parsePoliticsResource({ ...source, sections })).toThrow();
  });
  it("treats missing data honestly and percentages consistently", () => {
    expect(displayValue(null)).toBe("Not recorded");
    expect(displayValue(0.31, "percent")).toBe("31%");
    expect(displayValue(123456, "currency")).toBe("$123,456");
  });
  it("normalizes punctuation, accents and term order for search", () => {
    expect(matchesSearch(normalSearch("José Rodríguez, District 35"), "Rodriguez Jose")).toBe(true);
    expect(matchesSearch(normalSearch("Alex Example"), "Example unknown")).toBe(false);
  });
  it("never exposes executable or credential-bearing source URLs", () => {
    for (const unsafe of ["javascript:alert(1)", "data:text/html,test", "https://user:pass@example.org", "//example.org", "not a url"]) expect(safeSourceUrl(unsafe)).toBeUndefined();
    expect(safeSourceUrl("https://www.nj.gov/")).toBe("https://www.nj.gov/");
  });
});
