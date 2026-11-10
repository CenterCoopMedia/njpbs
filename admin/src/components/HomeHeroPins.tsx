import { useContext, useEffect, useId, useRef, useState } from "react";
import { HOME_HERO_PIN_LIMIT, type HomeHeroPin } from "../../../packages/content-core/src/home-hero";
import { livePublishedSourceVersion } from "../lib/content-status";
import { ContentShelfPicker, ContentShelfSources } from "./ContentShelfPicker";
import { FieldRenderer } from "./FieldRenderer";
import { ActionControl } from "./ui/ActionControl";

const identity = (pin: HomeHeroPin) => `${pin.source}:${pin.sourceId}`;

/** Presentation only; RecordForm retains the metadata draft and save owner. */
export function HomeHeroPins({ pins, onChange, onDraftError }: {
  pins: readonly HomeHeroPin[];
  onChange: (pins: HomeHeroPin[]) => void;
  onDraftError: (key: string, message: string | null) => void;
}) {
  const sources = useContext(ContentShelfSources);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const group = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  const key = pins.map(identity).join("\0");
  useEffect(() => {
    let current = true;
    const pages = pins.some(pin => pin.source === "cms_pages") ? sources.loadPages?.() : undefined;
    void Promise.all(pins.map(async pin => {
      if (pin.source === "cms_pages") {
        try {
          const page = (await pages)?.find(page => page.id === pin.sourceId);
          if (current) setTitles(previous => ({ ...previous, [identity(pin)]: page?.published && page.livePath
            ? page.liveTitle ?? "Published Page" : "Unavailable content" }));
        } catch { /* Keep the saved identity available for removal or retry. */ }
        return;
      }
      if (!sources.loadRecord) return;
      try {
        const result = await sources.loadRecord("post", pin.sourceId);
        const record = result.status === "ready" ? result.record : undefined;
        const published = record?.published as { sourceVersion?: unknown; metadata?: { title?: unknown } } | undefined;
        const title = record && record.deleted !== true && livePublishedSourceVersion(record) !== null &&
          published?.sourceVersion === livePublishedSourceVersion(record) ? published?.metadata?.title : undefined;
        if (current) setTitles(previous => ({ ...previous, [identity(pin)]: typeof title === "string" ? title : "Unavailable content" }));
      } catch { /* Retain the selected identity and let staff retry or remove it. */ }
    }));
    return () => { current = false; };
  }, [key, sources.loadRecord, sources.loadPages]);
  function focus(index?: number) {
    requestAnimationFrame(() => {
      const rows = group.current?.querySelectorAll<HTMLElement>("[data-hero-pin]");
      (index !== undefined ? rows?.[index] : group.current)?.focus();
    });
  }
  function move(index: number, direction: number) {
    const next = [...pins];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next); focus(index + direction);
  }
  return <fieldset className="record-field-group home-hero-pins" ref={group} tabIndex={-1}>
    <legend>Pinned</legend>
    <p>Pin up to three published Posts or Pages. The first available pin leads; other slots fill automatically without duplicates. Your maximum story count still applies.</p>
    <p>End times use Eastern time (EST/EDT). An ended pin loses its priority on the next Home refresh; it can still appear if it matches auto fill.</p>
    {pins.length === 0 ? <p>No pins. All stories fill automatically.</p> : <ol>
      {pins.map((pin, index) => <li key={identity(pin)} data-hero-pin tabIndex={-1}>
        <strong>{titles[identity(pin)] ?? `${pin.source === "cms_posts" ? "Post" : "Page"} ${pin.sourceId}`}</strong>
        <small> · {index === 0 ? "Lead" : `Pin ${index + 1}`}</small>
        <div className="button-row">
          <ActionControl action="move-up" label={`Move pin ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} />
          <ActionControl action="move-down" label={`Move pin ${index + 1} down`} disabled={index === pins.length - 1} onClick={() => move(index, 1)} />
          <ActionControl action="remove-item" label={`Remove pin ${index + 1}`} onClick={() => {
            onChange(pins.filter((_, position) => index !== position));
            focus(pins.length > 1 ? Math.min(index, pins.length - 2) : undefined);
          }} />
        </div>
        <FieldRenderer field={{ key: "endsAt", label: `Pin ${index + 1} end time (Eastern)`, kind: "datetime", required: false,
          help: "Optional. Leave blank to keep the pin until you remove it. Eastern time follows daylight saving time." }}
          fieldId={`${id}-${pin.source}-${pin.sourceId}-end`} value={pin.endsAt ?? ""}
          onDraftError={message => onDraftError(identity(pin), message)}
          onChange={value => onChange(pins.map((item, position) => {
            if (position !== index) return item;
            const { endsAt: _endsAt, ...rest } = item;
            return value ? { ...rest, endsAt: String(value) } : rest;
          }))} />
      </li>)}
    </ol>}
    <ContentShelfPicker purpose="hero-pin" disabled={pins.length >= HOME_HERO_PIN_LIMIT} onAdd={() => {}}
      onPin={(pin, title) => {
        if (pins.some(item => identity(item) === identity(pin))) { setNotice("This content is already pinned."); return; }
        if (pins.length >= HOME_HERO_PIN_LIMIT) return;
        setTitles(previous => ({ ...previous, [identity(pin)]: title }));
        onChange([...pins, pin]); setNotice(`Pinned ${title}.`);
        focus(pins.length);
      }} />
    {pins.length >= HOME_HERO_PIN_LIMIT ? <p>Three pins selected. Remove a pin to choose another.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </fieldset>;
}
