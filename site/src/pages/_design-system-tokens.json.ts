import tokenSource from "../styles/design-tokens.css?raw";
import {
  DESIGN_SYSTEM_VERSION,
  parseDesignTokens,
} from "../lib/design-system-catalog";

export const prerender = true;

export function GET() {
  return new Response(
    `${JSON.stringify(
      {
        name: "NJ PBS Design and Asset Lab",
        version: DESIGN_SYSTEM_VERSION,
        source: "site/src/styles/design-tokens.css",
        tokens: parseDesignTokens(tokenSource),
      },
      null,
      2,
    )}\n`,
    {
      headers: {
        "Content-Disposition": `attachment; filename="njpbs-design-tokens-v${DESIGN_SYSTEM_VERSION}.json"`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}
