import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The old shared onboarding register was retired. Protect its replacement, the
// Boardwalk guide sources, and any onboarding docs restored later. This is a
// preventive check for employee logistics, not a general personal-data detector.
const EMPLOYEE_DETAIL =
  /\b(?:private\s+plan|start(?:\s+|-)date|personal\s+(?:gmail|e-?mail)|arrive\s+(?:about|at|by)|arrival(?:\s+(?:time|date|instructions))?(?=\s*:)|first\s+assignment|park\s+in|first\s+day\s+reporting)\b/gi;
// A named action needs a nearby date or clock time, not just "at" or a number:
// "Publishing begins at the top of the hour" and "Upload starts at 0 percent"
// are ordinary guide instructions. Read across Markdown line wrapping.
const PERSON_START = /\b[A-Z][a-z]*\s+(?:will\s+|is\s+)?(?:begins?|beginning|starts?|starting|arrives?|arriving|reports?|reporting|joins?|joining)\b[^.!?;]{0,80}?(?:\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/\d{2,4})?\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*[aApP]\.?[mM]\b\.?|\bnext\s+(?:week|month)\b|\b(?:today|tomorrow|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day)\b)/g;
// Guides need a person cue or an onboarding section. Capitalization alone
// also matches products and actions.
// Onboarding paths already supply the personnel context.
const EMPLOYEE_SUBJECT = /\b(?:[Ee]mployee|[Ss]taff member|[Nn]ew hire|[Cc]olleague)\s*:?\s*(?:[A-Z][a-z]*\s+)*$/;
const EMAIL = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
// Shared guide instructions may name shared contacts or synthetic tutorial
// accounts. Onboarding records and snapshot rows retain the original no-email rule.
const GUIDE_CONTACTS = new Set([
  "user-0c949380b2@example.org", "user-dcf31f69a4@example.org", "njpbs@montclair.edu",
]);
const EXAMPLE_DOMAINS = ["example.com", "example.org", "example.net"];

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${path}`);
    if (entry.isDirectory()) return markdownFiles(path);
    return /\.mdx?$/i.test(entry.name) ? [path] : [];
  });
}

function scan(root) {
  const guideRoot = join(root, "site/src/pages/_admin-docs");
  const guideFiles = existsSync(guideRoot) ? markdownFiles(guideRoot) : [];
  if (guideFiles.length === 0) throw new Error("Guide source is missing or empty");
  const onboardingRoot = join(root, "docs/onboarding");
  const onboardingFiles = existsSync(onboardingRoot) ? markdownFiles(onboardingRoot) : [];
  const files = [...guideFiles, ...onboardingFiles];
  const findings = [];
  for (const file of files) {
    const onboarding = onboardingFiles.includes(file);
    const source = readFileSync(file, "utf8");
    const fileFindings = new Set();
    for (const [rule, pattern] of [["logistics", EMPLOYEE_DETAIL], ["named-start", PERSON_START], ["email", EMAIL]]) {
      for (const match of source.matchAll(pattern)) {
        if (rule === "named-start" && !onboarding) {
          const preceding = source.slice(0, match.index);
          const heading = preceding.match(/^#{1,6}\s+.*$/gm)?.at(-1) ?? "";
          const onboardingSection = /\b(?:onboarding|new hire|personnel)\b/i.test(heading);
          if (!onboardingSection && !EMPLOYEE_SUBJECT.test(preceding)) continue;
        }
        if (rule === "email") {
          const rowStart = source.lastIndexOf("\n", match.index - 1) + 1;
          const snapshot = /^\s*\|\s*C-\d+\s*\|/.test(source.slice(rowStart, match.index));
          const domain = match[1].toLowerCase();
          const synthetic = EXAMPLE_DOMAINS.some((example) => domain === example || domain.endsWith(`.${example}`));
          const permitted = GUIDE_CONTACTS.has(match[0].toLowerCase()) || synthetic;
          if (!onboarding && !snapshot && permitted) continue;
        }
        const line = source.slice(0, match.index).split("\n").length;
        fileFindings.add(`${relative(root, file).split("\\").join("/")}:${line}: ` +
          `Employee-specific onboarding detail [${rule}]; keep it in the restricted personnel record.`);
      }
    }
    findings.push(...fileFindings);
  }
  if (findings.length) throw new Error(findings.join("\n"));
  return files.length;
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--root")) {
    throw new Error("Usage: node check-onboarding-source-privacy.mjs [--root <repository>]");
  }
  const root = args.length ? resolve(args[1]) : fileURLToPath(new URL("../../", import.meta.url));
  console.log(`Checked ${scan(root)} shared onboarding and guide sources.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
