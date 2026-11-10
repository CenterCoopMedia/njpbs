import { describe, expect, it } from "vitest";
import { extractPassages } from "../src/search/build-corpus";

describe("search corpus text boundaries", () => {
  it("preserves inline words and punctuation while separating block content", () => {
    const html =
      '<html><body><main data-pagefind-body><h1>Guide</h1><p>Open <strong>Edit transcript</strong>. Re<em>check</em> it.</p><p>First<br>second <a href="/">link</a>, then save.</p></main></body></html>';
    expect(extractPassages(html, "/admin/docs/", "guide")[0].text).toBe(
      "Open Edit transcript. Recheck it. First second link, then save.",
    );
  });
  it("keeps ignored controls and script text out of the corpus", () => {
    const html =
      "<html><body><main data-pagefind-body><h1>Guide</h1><p>Read <span data-pagefind-ignore>ignore me</span><strong>this</strong>.<button>Action</button><script>secret()</script></p></main></body></html>";
    expect(extractPassages(html, "/admin/docs/", "guide")[0].text).toBe(
      "Read this.",
    );
  });
});
