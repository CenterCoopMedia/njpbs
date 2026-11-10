export const READER_TEXT_SIZE_KEY = "njpbs-reader-text-size";
/** @type {readonly ["standard", "large", "largest"]} */
export const READER_TEXT_SIZES = ["standard", "large", "largest"];
/** @typedef {(typeof READER_TEXT_SIZES)[number]} ReaderTextSize */

/** @param {unknown} value @returns {ReaderTextSize} */
function textSize(value) {
  return READER_TEXT_SIZES.find(size => size === value) ?? "standard";
}

/** A local reading preference; storage denial must never disable the controls.
 * @param {Document} doc
 * @param {Window} win
 * @returns {() => void}
 */
export function installReaderTextSize(doc, win) {
  const controls = /** @type {HTMLElement[]} */ ([...doc.querySelectorAll("[data-reader-text-size-picker]")]);
  if (controls.length === 0) return () => {};
  const copy = doc.querySelectorAll(
    ".cms-block--prose :is(p, ul, ol, blockquote), .public-article__body > :is(p, ul, ol, blockquote), " +
    ".public-page__copy :is(p, ul, ol, blockquote):not(.public-page__summary, .public-page__section-links), " +
    ".public-page__cms-note :is(p, ul, ol, blockquote), .live-blog__body, " +
    ".live-blog__correction, .data-hub .featured-finding__lead, .data-hub .notes__body p",
  );
  if (![...copy].some(node => node.textContent?.trim())) return () => {};

  /** @param {unknown} value */
  const apply = (value) => {
    const size = textSize(value);
    doc.documentElement.dataset.readerTextSize = size;
    controls.forEach(control => {
      control.querySelectorAll("input[type=radio]").forEach(node => {
        const input = /** @type {HTMLInputElement} */ (node);
        input.checked = input.value === size;
      });
    });
  };
  const restore = () => {
    try { apply(win.localStorage.getItem(READER_TEXT_SIZE_KEY)); }
    catch { /* Keep the current in-memory preference when storage is blocked. */ }
  };
  apply(doc.documentElement.dataset.readerTextSize);
  restore();

  /** @param {Event} event */
  const change = (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.tagName !== "INPUT" || input.type !== "radio" || !input.checked) return;
    const size = textSize(input.value);
    apply(size);
    try { win.localStorage.setItem(READER_TEXT_SIZE_KEY, size); }
    catch { /* The choice still works for this visit. */ }
  };
  controls.forEach(control => {
    // Data Hub owns its introduction as compiled HTML and may move that whole
    // section during composition. Keep its picker with the introduction.
    if (control.dataset.readerWithin === "data-hub") {
      const intro = doc.querySelector(".data-hub .intro__inner") ?? doc.querySelector(".data-hub .intro");
      intro?.append(control);
    }
    control.addEventListener("change", change);
    control.hidden = false;
  });
  /** @param {StorageEvent} event */
  const storage = (event) => {
    if (event.key === READER_TEXT_SIZE_KEY || event.key === null) restore();
  };
  win.addEventListener("storage", storage);
  win.addEventListener("pageshow", restore);
  return () => {
    controls.forEach(control => control.removeEventListener("change", change));
    win.removeEventListener("storage", storage);
    win.removeEventListener("pageshow", restore);
  };
}

// Loaded directly as a module URL by the picker; server imports only use the
// constants and route policy. Keep this file plain JavaScript for that URL.
if (typeof document !== "undefined") installReaderTextSize(document, window);
