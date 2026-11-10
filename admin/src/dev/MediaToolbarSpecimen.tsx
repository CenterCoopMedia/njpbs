import { ActionControl } from "../components/ui/ActionControl";
import { Icon } from "../components/ui/Icon";
import { OverflowToolbar } from "../components/ui/OverflowToolbar";

// Gallery specimen for the media toolbar. At narrow widths the center controls move into
// the More menu instead of wrapping; once they are all there, More absorbs Display too.
// Display follows the icon or text presentation, so the text captures overflow sooner.
// Local only; no control changes data.
export function MediaToolbarSpecimen() {
  const noop = () => {};
  return (
    <div className="panel" style={{ display: "grid", gap: "var(--cms-space-4)" }}>
      <OverflowToolbar
        items={[
          {
            key: "filter",
            priority: 3,
            node: (
              <button className="button button-secondary" type="button">
                <Icon name="filter" />
                Filter
              </button>
            ),
            menuItem: { key: "filter", label: "Filter", icon: "filter", onSelect: noop },
          },
          {
            key: "sort",
            priority: 2,
            node: (
              <button className="button button-secondary" type="button">
                <Icon name="sort" />
                Sort: Last updated
              </button>
            ),
            menuItem: { key: "sort", label: "Sort: Last updated", icon: "sort", onSelect: noop },
          },
          {
            key: "select",
            priority: 1,
            node: (
              <button className="button button-ghost" type="button">
                <Icon name="check-square" />
                Select page
              </button>
            ),
            menuItem: { key: "select", label: "Select page", icon: "check-square", onSelect: noop },
          },
          {
            key: "display",
            priority: 1,
            zone: "trailing",
            node: <ActionControl action="view-options" label="Display" variant="ghost" />,
            menuItem: { key: "display", label: "Display", icon: "sliders", onSelect: noop },
          },
        ]}
        label="Images actions"
        search={<input aria-label="Search media" className="field-control" placeholder="Search media" type="search" />}
        trailing={<button className="button button-primary" type="button"><Icon name="upload" />Upload</button>}
      />
    </div>
  );
}
