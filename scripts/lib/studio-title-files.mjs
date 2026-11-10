import { parseStudioConfiguration } from "../../agents/vmix/configuration.mjs";

export function studioTitleFilesParameter(encoded, enabled) {
  if (!["true", "false"].includes(enabled)) throw new Error("Studio feature configuration is unavailable");
  try {
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 16 * 1024) throw new Error();
    const { titleFiles } = parseStudioConfiguration(JSON.parse(encoded));
    // Single-quoted dotenv values preserve JSON escapes and # characters. Encode
    // apostrophes inside JSON so none can terminate the surrounding dotenv quote.
    return JSON.stringify({ headline: titleFiles.headline, name_title: titleFiles.name_title }).replaceAll("'", "\\u0027");
  } catch {
    if (enabled === "false") return "";
    throw new Error("Studio preset configuration is unavailable");
  }
}
