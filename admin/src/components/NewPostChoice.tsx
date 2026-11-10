import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import { useDismissibleOverlay } from "../hooks/useDismissibleOverlay";
import { createRecordPath, postTemplatesPath } from "../lib/routes";
import { Button, buttonClassName } from "./ui/Primitives";
import { useControlSize } from "../context/ControlSizingContext";
import { Icon } from "./ui/Icon";
import "./PostTemplates.css";

export function NewPostChoice({ origin, label = "New post" }: { origin?: unknown; label?: string }) {
  const size = useControlSize() ?? "legacy";
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useDismissibleOverlay({ open, root, trigger, onClose: () => setOpen(false) });
  return <div className="post-start-choice" ref={root}>
    <Link className={buttonClassName("primary", size)} to={createRecordPath("post")} state={origin}><Icon name="plus" />{label}</Link>
    <Button ref={trigger} aria-label="Choose a post starting point" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}><Icon name="chevron-down" /></Button>
    <nav id={menuId} className="post-template-action-menu" aria-label="Post starting point" hidden={!open}>
      <Link className={buttonClassName("ghost", size)} to={createRecordPath("post")} state={origin}>Blank post</Link>
      <Link className={buttonClassName("ghost", size)} to={postTemplatesPath()}>From template</Link>
    </nav>
  </div>;
}
