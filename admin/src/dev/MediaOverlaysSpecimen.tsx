import { useRef, useState } from "react";
import { Checkbox } from "../components/ui/Checkbox";
import { HoverCard } from "../components/ui/HoverCard";
import { Icon } from "../components/ui/Icon";
import { ContextMenuArea, Menu, type MenuItem } from "../components/ui/Menu";
import { Popover } from "../components/ui/Popover";
import { SegmentedControl } from "../components/ui/SegmentedControl";

const items: MenuItem[] = [
  { key: "open", label: "Open", icon: "eye", onSelect: () => {} },
  { key: "favorite", label: "Favorite", icon: "heart", onSelect: () => {} },
  { key: "collect", label: "Add to collection", icon: "folder-plus", group: "organize", onSelect: () => {} },
  { key: "tags", label: "Edit tags", icon: "tag", group: "organize", onSelect: () => {} },
  { key: "delete", label: "Delete from library", icon: "trash", danger: true, group: "danger", onSelect: () => {} },
];

// Gallery specimen for the media library's layered surfaces. The Display popover
// starts open so the specimen shows it; the menu, context menu and hover card open on use.
export function MediaOverlaysSpecimen() {
  const displayRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [size, setSize] = useState<"s" | "m" | "l">("m");
  const [fields, setFields] = useState({ name: true, size: true, tags: true, uploader: false });

  return (
    <div className="panel" style={{ display: "flex", gap: "var(--cms-space-2)", alignItems: "center", flexWrap: "wrap" }}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="button button-secondary"
        onClick={() => setOpen(!open)}
        ref={displayRef}
        type="button"
      >
        <Icon name="sliders" />
        Display
      </button>
      <Menu items={items} label="More actions" />
      <ContextMenuArea items={items} label="Sunset over Newark">
        <button className="button button-ghost" type="button">Right-click me</button>
      </ContextMenuArea>
      <HoverCard
        content={<p>Studio B walkthrough.mp4 · 12:34 · 1.4 GB · studio, b-roll</p>}
        label="Details for Studio B walkthrough"
      >
        <button className="button button-ghost" type="button">Studio B walkthrough</button>
      </HoverCard>
      <Popover anchorRef={displayRef} label="Display" onOpenChange={setOpen} open={open}>
        <div style={{ display: "grid", gap: "var(--cms-space-3)", gridTemplateColumns: "auto 1fr", alignItems: "center" }}>
          <span>Layout</span>
          <SegmentedControl
            label="Layout"
            onChange={setLayout}
            options={[{ value: "grid", label: "Grid", icon: "grid" }, { value: "list", label: "List", icon: "columns" }]}
            value={layout}
          />
          <span>Thumbnails</span>
          <SegmentedControl
            label="Thumbnails"
            onChange={setSize}
            options={[{ value: "s", label: "S" }, { value: "m", label: "M" }, { value: "l", label: "L" }]}
            value={size}
          />
          <span>Show fields</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
            <Checkbox checked disabled label="Name" onChange={() => {}} />
            <Checkbox checked={fields.size} label="Size" onChange={() => setFields({ ...fields, size: !fields.size })} />
            <Checkbox checked={fields.tags} label="Tags" onChange={() => setFields({ ...fields, tags: !fields.tags })} />
            <Checkbox checked={fields.uploader} label="Uploader" onChange={() => setFields({ ...fields, uploader: !fields.uploader })} />
          </div>
        </div>
      </Popover>
    </div>
  );
}
