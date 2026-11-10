// Accessibility static-analysis gate for Astro templates (issue #339).
//
// eslint-plugin-jsx-a11y cannot run here: the site is Astro with no JSX, so its
// JSX-attribute rules never match. eslint-plugin-astro re-exports the same rule
// set as astro/jsx-a11y/* against the Astro template AST via astro-eslint-parser,
// which is what this config enables. Scope is a11y only (the jsx-a11y-recommended
// preset carries the parser setup plus the a11y rules, not the general astro
// style rules), over src/**/*.astro. It runs in the verify path next to
// `npm run check` and `npm test`.
import astro from "eslint-plugin-astro";

export default [
  { ignores: ["dist/**", ".astro/**"] },
  ...astro.configs["jsx-a11y-recommended"],
  {
    files: ["**/*.astro"],
    rules: {
      // The homepage program rails are role="group" scroll containers made
      // keyboard-focusable (tabindex="0") so keyboard users can scroll them,
      // per axe scrollable-region-focusable / WCAG 2.1.1 Keyboard. Allow the
      // attribute on that role; the rule still guards every other
      // non-interactive element (its default allowlist is tabpanel only).
      "astro/jsx-a11y/no-noninteractive-tabindex": [
        "error",
        { tags: [], roles: ["tabpanel", "group"], allowExpressionValues: true },
      ],
    },
  },
];
