import tokenSource from "../styles/design-tokens.css?raw";
import { DESIGN_SYSTEM_VERSION } from "../lib/design-system-catalog";

export const prerender = true;

export function GET() {
  return new Response(tokenSource, {
    headers: {
      "Content-Disposition": `attachment; filename="njpbs-design-tokens-v${DESIGN_SYSTEM_VERSION}.css"`,
      "Content-Type": "text/css; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
