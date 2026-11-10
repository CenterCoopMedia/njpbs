import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../ui/Primitives";
import { Popover } from "../ui/Popover";
import "./CopyMediaLink.css";

export function CopyMediaLink({ path, disabled = false }: { path: string | (() => string); disabled?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <Button ref={anchor} disabled={disabled} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>Copy link</Button>
    <CopyMediaLinkPanel path={path} open={open} onOpenChange={setOpen} anchorRef={anchor} />
  </>;
}

export function CopyMediaLinkPanel({ path, open, onOpenChange, anchorRef }: {
  path: string | (() => string);
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const pathRef = useRef(path);
  pathRef.current = path;
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!open) return;
    const current = pathRef.current;
    setUrl(new URL(typeof current === "function" ? current() : current, window.location.origin).href);
    setMessage("");
  }, [open]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Link copied.");
    } catch {
      setMessage("Select and copy the address below.");
    }
  }
  return <Popover anchorRef={anchorRef} label="Internal media link" open={open} onOpenChange={onOpenChange} className="media-copy-link-panel">
      <h3>Link to this file or collection</h3>
      <input aria-label="Internal media link" readOnly value={url} onFocus={event => event.currentTarget.select()} />
      <Button onClick={() => void copy()}>Copy</Button>
      <p>This link opens for staff who already have access. Copying it does not grant permission or access to files in a collection.</p>
      {message ? <p role="status">{message}</p> : null}
    </Popover>;
}
