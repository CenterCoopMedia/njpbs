import type { MediaHoverFacts as MediaHoverFactsData } from "../../lib/media-hover-facts";
import "./MediaHoverFacts.css";

// The hover card body for a media card or list row: the full name, then the facts as a description list. Built only from the facts the
// caller derived from the loaded summary, so it never fetches.
export function MediaHoverFacts({ facts }: { facts: MediaHoverFactsData }) {
  return (
    <div className="media-hover-facts">
      <p className="media-hover-facts-name">{facts.name}</p>
      <dl className="media-hover-facts-list">
        {facts.facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
        {facts.tags.length > 0 ? (
          <div>
            <dt>Tags</dt>
            <dd>{facts.tags.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
