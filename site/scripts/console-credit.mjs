const CONSOLE_CREDIT_SCRIPT = String.raw`
(function () {
  try {
    var host = window.location && window.location.host ? window.location.host : "this site";
    console.info(
      "%cNJ PBS%c built by Joe Amditis%c - " + host,
      "background:#2638c4;color:#fff;font-weight:800;padding:2px 6px;border-radius:4px",
      "color:#f8fafc;font-weight:800",
      "color:#9ca3af;font-weight:600"
    );
  } catch (error) {
    /* Console credit only; never affect page behavior. */
  }
})();
`.trim();

export const CONSOLE_CREDIT_TAG = `<script data-njpbs-console-credit>${CONSOLE_CREDIT_SCRIPT}</script>`;
