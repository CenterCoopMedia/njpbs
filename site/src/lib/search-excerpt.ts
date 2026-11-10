/** Normalize whitespace without changing the chosen relevance window. */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export function plainExcerpt(text: string, limit: number): string {
  const normalized = normalize(text);
  if (normalized.length <= limit) return normalized;
  const boundary = normalized.lastIndexOf(" ", limit);
  // If the first word exceeds the bound, omit it rather than split it.
  return boundary > 0 ? `${normalized.slice(0, boundary)} …` : "…";
}

/** Pagefind HTML is untrusted: emit fresh text and mark nodes only. */
export function pagefindExcerpt(
  html: string,
  content?: string,
): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = document.createDocumentFragment();
  let text = "";
  let pendingSpace = false;
  const walk = (node: Node, marked: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      let value = "";
      for (const character of node.textContent || "") {
        if (/\s/.test(character)) {
          pendingSpace = text.length > 0 || value.length > 0;
          continue;
        }
        if (pendingSpace) {
          if (value) value += " ";
          else {
            fragment.append(document.createTextNode(" "));
            text += " ";
          }
        }
        value += character;
        pendingSpace = false;
      }
      if (!value) return;
      text += value;
      if (marked) {
        const mark = document.createElement("mark");
        mark.textContent = value;
        fragment.append(mark);
      } else fragment.append(document.createTextNode(value));
      return;
    }
    if (
      node instanceof Element &&
      ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "TEMPLATE"].includes(node.tagName)
    )
      return;
    for (const child of node.childNodes)
      walk(
        child,
        marked || (node instanceof Element && node.tagName === "MARK"),
      );
  };
  walk(template.content, false);
  const full = content === undefined ? "" : normalize(content);
  const start = text ? full.indexOf(text) : -1;
  const lastStart = text ? full.lastIndexOf(text) : -1;
  // Pagefind does not expose its chosen excerpt offset. For repeated text,
  // mark an omitted end only when every possible occurrence omits that end.
  if (start > 0 && !/^(?:…|\.\.\.)/.test(text))
    fragment.prepend(document.createTextNode("… "));
  if (
    start >= 0 &&
    lastStart + text.length < full.length &&
    !/(?:…|\.\.\.)$/.test(text)
  )
    fragment.append(document.createTextNode(" …"));
  return fragment;
}
