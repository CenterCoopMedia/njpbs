import type { ReactNode } from "react";
import { Inspector } from "../ui/Inspector";
import "./UploadSheet.css";

export interface UploadSheetProps {
  children: ReactNode;
  dirty?: boolean;
  focusReturn?: HTMLElement | null;
  footer?: ReactNode;
  heading: string;
  label?: string;
  onFocusFallback?: () => void;
  /** Hides the queue without discarding metadata or stopping transfers. */
  onDismiss?: () => void;
  onRequestClose: () => void;
  open: boolean;
}

/** A fixed-width inspector host. The route keeps ownership of queue and discard decisions. */
export function UploadSheet({
  children,
  dirty = false,
  focusReturn,
  footer,
  heading,
  label = "Upload media",
  onFocusFallback,
  onRequestClose,
  onDismiss = onRequestClose,
  open,
}: UploadSheetProps) {
  return (
    <Inspector
      alignTo=".media-grid"
      className="media-upload-sheet"
      closeLabel="Close upload"
      dirty={dirty}
      focusReturn={focusReturn}
      footer={footer}
      fitViewport
      heading={heading}
      keepMounted
      label={label}
      onClose={onRequestClose}
      onClickOutside={onDismiss}
      onDirtyEscape={onRequestClose}
      onFocusFallback={onFocusFallback}
      open={open}
      resizable={false}
      storageKey="media-upload"
    >
      {children}
    </Inspector>
  );
}
