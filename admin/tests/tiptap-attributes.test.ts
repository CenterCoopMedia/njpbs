import { mergeAttributes } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { expect, it } from "vitest";

it("keeps an own __proto__ key from supplying inherited DOM attributes", () => {
  const untrusted = JSON.parse('{"__proto__":{"onerror":"alert(1)","onclick":"alert(2)"},"class":"incoming"}');
  expect(Object.hasOwn(untrusted, "__proto__")).toBe(true);

  const attributes = mergeAttributes({ class: "existing", title: "Retained" }, untrusted);
  expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
  expect(Object.hasOwn(attributes, "__proto__")).toBe(true);
  expect(attributes.onerror).toBeUndefined();
  expect(attributes.onclick).toBeUndefined();

  const { dom } = DOMSerializer.renderSpec(document, ["span", attributes, "Label"]);
  expect(dom).toBeInstanceOf(HTMLSpanElement);
  const element = dom as HTMLSpanElement;
  expect(element.hasAttribute("onerror")).toBe(false);
  expect(element.hasAttribute("onclick")).toBe(false);
  expect(element.className).toBe("existing incoming");
  expect(element.title).toBe("Retained");
});
