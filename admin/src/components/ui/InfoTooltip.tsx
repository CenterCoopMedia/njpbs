import { useId } from "react";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

/** Supplemental help: a small glyph with separate fine-pointer and touch targets, available to hover, touch, and keyboard. */
export function InfoTooltip({ label, content, descriptionId: suppliedDescriptionId }: { label: string; content: string; descriptionId?: string }) {
  const generatedDescriptionId = useId();
  const descriptionId = suppliedDescriptionId ?? generatedDescriptionId;
  return (
    <>
      <Tooltip content={content} openOnClick>
        <button type="button" className="info-tooltip-trigger" aria-label={`About ${label}`}
          aria-describedby={descriptionId}>
          <Icon name="info" />
        </button>
      </Tooltip>
      <span className="sr-only" id={descriptionId}>{content}</span>
    </>
  );
}
