import { expect, it } from "vitest";
import controls from "../../functions/lib/serializer-publication-control.js";
it("accepts only exact serializer-control shapes", () => {
  for (const enabled of [true, false]) {
    expect(controls.parseSerializerPublicationControl({ schemaVersion: 1, enabled })).toEqual({ schemaVersion: 1, enabled });
  }
  for (const value of [null, {}, [], { schemaVersion: 2, enabled: false }, { schemaVersion: 1, enabled: "false" },
    { schemaVersion: 1, enabled: false, other: true }]) {
    expect(() => controls.parseSerializerPublicationControl(value)).toThrow("Publication control is unavailable");
  }
});
