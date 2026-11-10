import { describe, expect, it } from "vitest";
import { publicationTarget, assertPublicationTarget, assertPublicationDatabase } from "../functions/lib/publication-target.js";

describe("publication target isolation", () => {
  it.each(["production", "development"])("accepts only the complete %s bundle", environment => {
    const target = publicationTarget(environment);
    expect(assertPublicationTarget({ ...target })).toEqual(target);
    expect(() => assertPublicationDatabase({ projectId: target.projectId }, target)).not.toThrow();
    const other = publicationTarget(environment === "production" ? "development" : "production");
    for (const key of Object.keys(target) as (keyof typeof target)[]) {
      expect(() => assertPublicationTarget({ ...target, [key]: other[key] })).toThrow();
    }
    expect(() => assertPublicationDatabase({ projectId: other.projectId }, target)).toThrow();
    expect(() => assertPublicationDatabase({}, target)).toThrow();
    expect(() => assertPublicationTarget({ ...target, endpoint: target.origin })).toThrow();
  });
  it.each(["dev", "staging", "emulator", "", "__proto__"])("refuses unknown environment %s", environment => {
    expect(() => publicationTarget(environment)).toThrow();
  });
});
