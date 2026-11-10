import { useRef, type Ref } from "react";
import { routeChosenFiles } from "../../lib/upload-router";
import { UNIVERSAL_UPLOAD_ACCEPT } from "../../lib/upload-destination";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Primitives";
import { ControlSizingProvider } from "../../context/ControlSizingContext";
import { WorkspaceBrowseToolbar } from "../WorkspaceActions";

// The upload control for a media tab that does not already have one. Images and an
// uploadable video source keep their own controls. This button uses the same accept
// list and the same router, so a mixed batch still splits by file type.
export function WorkspaceUploadButton({ buttonRef, secondary = false }: { buttonRef?: Ref<HTMLButtonElement>; secondary?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <ControlSizingProvider size="standard"><WorkspaceBrowseToolbar trailing><div className="media-workspace-upload">
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept={UNIVERSAL_UPLOAD_ACCEPT}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) routeChosenFiles(picked);
        }}
      />
      <Button
        aria-label="Upload media"
        className="media-workspace-upload-button"
        onClick={() => inputRef.current?.click()}
        ref={buttonRef}
        title="Upload images, PDFs, WAV audio, or videos"
        variant={secondary ? "secondary" : "primary"}
      >
        <Icon name="upload" />
        <span className="button-compact-label">Upload</span>
      </Button>
    </div></WorkspaceBrowseToolbar></ControlSizingProvider>
  );
}
