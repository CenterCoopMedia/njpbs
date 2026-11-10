import {
  useEffect,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import "./DropOverlay.css";

export interface DropOverlayProps {
  blocked?: boolean;
  canUpload: boolean;
  children: ReactNode;
  destination: string;
  onFiles: (files: readonly File[]) => void;
}

function advertisesFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

/** A file-aware drop target. Permission, dirty state, and intake stay with its route owner. */
export function DropOverlay({
  blocked = false,
  canUpload,
  children,
  destination,
  onFiles,
}: DropOverlayProps) {
  const [active, setActive] = useState(false);
  const available = canUpload;

  useEffect(() => {
    if (!available) setActive(false);
  }, [available]);

  function accepts(event: DragEvent<HTMLDivElement>): boolean {
    return available && advertisesFiles(event.dataTransfer);
  }

  return (
    <div
      className="media-drop-target"
      onDragEnter={(event) => {
        if (!advertisesFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (available) setActive(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setActive(false);
      }}
      onDragOver={(event) => {
        if (!advertisesFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (available) setActive(true);
        event.dataTransfer.dropEffect = accepts(event) && !blocked ? "copy" : "none";
      }}
      onDrop={(event) => {
        if (!advertisesFiles(event.dataTransfer)) return;
        event.preventDefault();
        setActive(false);
        if (!accepts(event) || blocked) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
    >
      {children}
      {active ? (
        <div
          aria-atomic="true"
          className="media-drop-overlay"
          data-blocked={blocked || undefined}
          role="status"
        >
          <strong>{blocked ? "Save or discard details first" : `Drop to upload to ${destination}`}</strong>
          <span>{blocked ? "Uploads stay unavailable while details have unsaved changes." : "Release the files to add them."}</span>
        </div>
      ) : null}
    </div>
  );
}
