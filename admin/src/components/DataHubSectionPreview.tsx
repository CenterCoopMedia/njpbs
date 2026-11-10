import { createElement } from "react";
import type { DataHubSectionData } from "../../../packages/content-core/src/data-hub-composition";
import { dataHubSectionSource } from "../lib/data-hub-section-source";

export default function DataHubSectionPreview({ data, level }: {data: DataHubSectionData; level: number}) {
  const source = dataHubSectionSource(data.sectionId);
  return <>
    {createElement(`h${level}`, { className: "block-preview-heading" }, data.heading.trim() || source.heading)}
    <p>{data.introduction.trim() || source.introduction}</p>
    {source.benchmarks?.map(item => <p key={item.label}>{item.label}: <strong>{item.display}</strong> · {item.period}</p>)}
    {source.display ? <p><strong>{source.display}</strong> · {source.period}</p> : null}
    {source.checked ? <p className="block-preview-note">Source checked {source.checked}</p> : null}
  </>;
}
