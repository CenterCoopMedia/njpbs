import type { Role } from "../../../packages/content-core/src/rbac";
import { ROLE_TEXT } from "../lib/role-text";

export function RoleExplanation({ role, headingLevel }: { role: Role; headingLevel: 3 | 4 }) {
  const text = ROLE_TEXT[role];
  const Heading = `h${headingLevel}` as "h3" | "h4";
  const ListHeading = `h${headingLevel + 1}` as "h4" | "h5";
  return (
    <div>
      <Heading>{text.name}</Heading>
      <p>{text.summary}</p>
      <ListHeading>Can</ListHeading>
      <ul>{text.can.map((line) => <li key={line}>{line}</li>)}</ul>
      <ListHeading>Cannot</ListHeading>
      <ul>{text.cannot.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}
