import { useState } from "react";
import { Checkbox } from "../components/ui/Checkbox";
import { Chip } from "../components/ui/Chip";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { TokenInput, type Token } from "../components/ui/TokenInput";

// Gallery specimen for the media library's small shared controls. Local state only.
export function MediaControlsSpecimen() {
  const [selected, setSelected] = useState(true);
  const [fields, setFields] = useState({ name: true, tags: true, uploader: false });
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [size, setSize] = useState<"s" | "m" | "l">("m");
  const [filters, setFilters] = useState(["Category: News", "Uploader: me"]);
  const [tags, setTags] = useState<Token[]>([
    { value: "news" },
    { value: "trenton", mixed: true },
    { value: "statehouse", mixed: true },
    { value: "b-roll", mixed: true },
  ]);

  return (
    <div className="panel" style={{ display: "grid", gap: "var(--cms-space-6)", maxWidth: "40rem" }}>
      <section aria-labelledby="specimen-checkbox" style={{ display: "grid", gap: "var(--cms-space-2)" }}>
        <h2 id="specimen-checkbox">Checkbox</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-4)" }}>
          <Checkbox checked={selected} hideLabel label="Select Sunset over Newark" onChange={() => setSelected(!selected)} />
          <Checkbox checked={false} indeterminate label="Select page" onChange={() => {}} />
          <Checkbox checked={fields.name} disabled label="Name" onChange={() => {}} />
          <Checkbox checked={fields.tags} label="Tags" onChange={() => setFields({ ...fields, tags: !fields.tags })} />
          <Checkbox
            checked={fields.uploader}
            label="Uploader"
            onChange={() => setFields({ ...fields, uploader: !fields.uploader })}
          />
        </div>
      </section>
      <section aria-labelledby="specimen-chip" style={{ display: "grid", gap: "var(--cms-space-2)" }}>
        <h2 id="specimen-chip">Chips</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-2)", alignItems: "center" }}>
          {filters.map((filter) => {
            const [property, value] = filter.split(": ");
            return (
              <Chip
                key={filter}
                onRemove={() => setFilters(filters.filter((item) => item !== filter))}
                onSelect={() => {}}
                property={property}
                value={value}
              />
            );
          })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-1)" }}>
          <Chip label="Filter by tag trenton" onSelect={() => {}} value="trenton" variant="tag" />
          <Chip label="Filter by tag statehouse" onSelect={() => {}} value="statehouse" variant="tag" />
          <Chip value="b-roll" variant="tag" />
        </div>
      </section>
      <section aria-labelledby="specimen-tags" style={{ display: "grid", gap: "var(--cms-space-2)" }}>
        <h2 id="specimen-tags">Tags, five items selected</h2>
        <TokenInput
          label="Tags"
          maxLength={40}
          onChange={setTags}
          suggestions={["election", "education", "energy", "shore", "studio", "transit"]}
          tokens={tags}
        />
      </section>
      <section aria-labelledby="specimen-segmented" style={{ display: "grid", gap: "var(--cms-space-2)" }}>
        <h2 id="specimen-segmented">Segmented control</h2>
        <SegmentedControl
          label="Layout"
          onChange={setLayout}
          options={[
            { value: "grid", label: "Grid", icon: "grid" },
            { value: "list", label: "List", icon: "columns" },
          ]}
          value={layout}
        />
        <SegmentedControl
          label="Thumbnails"
          onChange={setSize}
          options={[
            { value: "s", label: "S" },
            { value: "m", label: "M" },
            { value: "l", label: "L" },
          ]}
          value={size}
        />
      </section>
    </div>
  );
}
