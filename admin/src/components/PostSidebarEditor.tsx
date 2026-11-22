import { useLayoutEffect, useRef, useState } from "react";
import { postSidebarSections, type PostSidebar, type PostSidebarSectionId } from "../../../packages/content-core/src/post-sidebar";
import { ActionControl } from "./ui/ActionControl";
import { Checkbox } from "./ui/Checkbox";
import "./PostSidebarEditor.css";

const SECTION_LABELS: Record<PostSidebarSectionId, string> = {
  overview: "On this page",
  contents: "Reporting sections",
  topics: "Categories and tags",
};

interface Props {
  id: string;
  value?: PostSidebar;
  liveBlog: boolean;
  disabled: boolean;
  onChange: (value: PostSidebar) => void;
}

export function PostSidebarEditor({ id, value, liveBlog, disabled, onChange }: Props) {
  const enabled = value?.enabled ?? true;
  const sections = postSidebarSections(value);
  const pendingFocus = useRef<string>();
  const [announcement, setAnnouncement] = useState("");

  useLayoutEffect(() => {
    if (pendingFocus.current) {
      document.getElementById(pendingFocus.current)?.focus();
      pendingFocus.current = undefined;
    }
  }, [value]);

  function move(index: number, direction: number) {
    const next = [...sections];
    const target = index + direction;
    const moved = next[index];
    [next[index], next[target]] = [next[target], moved];
    pendingFocus.current = `${id}-${moved.id}`;
    onChange({ enabled, sections: next });
    setAnnouncement(`${SECTION_LABELS[moved.id]} moved to position ${target + 1} of ${next.length}.`);
  }

  return <div className="post-sidebar-editor">
    <Checkbox label="Show sidebar on the public Post" checked={enabled} disabled={disabled}
      onChange={event => onChange({ ...value, enabled: event.currentTarget.checked })} />
    {liveBlog ? <p>To change the sidebar content or order, edit the sidebar blocks in the Post body.</p> : (
      <fieldset disabled={disabled || !enabled}>
        <legend>Sidebar sections</legend>
        <ol className="post-sidebar-editor__sections">
          {sections.map((section, index) => {
            const label = SECTION_LABELS[section.id];
            return <li key={section.id}>
              <Checkbox id={`${id}-${section.id}`} label={label} checked={section.visible}
                onChange={event => onChange({ enabled, sections: sections.map(item =>
                  item.id === section.id ? { ...item, visible: event.currentTarget.checked } : item) })} />
              <div className="post-sidebar-editor__actions">
                <ActionControl action="move-up" accessibleName={`Move ${label} up`} disabled={index === 0} onClick={() => move(index, -1)} />
                <ActionControl action="move-down" accessibleName={`Move ${label} down`} disabled={index === sections.length - 1} onClick={() => move(index, 1)} />
              </div>
            </li>;
          })}
        </ol>
        <p role="status" className="sr-only">{announcement}</p>
      </fieldset>
    )}
  </div>;
}
