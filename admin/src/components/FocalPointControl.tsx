import { InfoTooltip } from "./ui/InfoTooltip";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { focalObjectPosition } from "../lib/author-identity";
import { boundedPlacement, cropWindow, placementAtPoint, type FocalPlacement } from "../lib/focal-placement";
import { Button } from "./ui/Primitives";
import "./focal-point-control.css";

interface FocalPointControlProps {
  src: string;
  value: FocalPlacement;
  onChange: (value: FocalPlacement) => void;
  aspectRatio?: number;
  disabled?: boolean;
}

// Preview a gesture locally. Only pointer-up commits to the existing form/undo owner.
export function FocalPointControl({ src, value, onChange, aspectRatio = 1, disabled = false }: FocalPointControlProps) {
  const descriptionId = useId();
  const imageRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLButtonElement>(null);
  const pointerRef = useRef<number | null>(null);
  const [image, setImage] = useState<{ src: string; width: number; height: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [gesture, setGesture] = useState<FocalPlacement | null>(null);
  const position = gesture ?? value;
  const loaded = image?.src === src && failedSrc !== src;
  const crop = loaded ? cropWindow(image.width, image.height, aspectRatio, position) : null;
  const canAdjust = !disabled && crop !== null;

  function releasePointer() {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    if (pointer !== null && surfaceRef.current?.hasPointerCapture(pointer)) {
      surfaceRef.current.releasePointerCapture(pointer);
    }
  }

  function cancelGesture() {
    releasePointer();
    setGesture(null);
  }

  useEffect(() => {
    cancelGesture();
    return releasePointer;
  }, [src, disabled, value.x, value.y]);

  function pointFromEvent(event: PointerEvent<HTMLButtonElement>): FocalPlacement | null {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height || !crop) return null;
    return placementAtPoint({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }, crop, value);
  }

  function startGesture(event: PointerEvent<HTMLButtonElement>) {
    if (!canAdjust || !event.isPrimary || event.button !== 0) return;
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    const next = pointFromEvent(event);
    if (!next) return;
    event.preventDefault();
    event.currentTarget.focus();
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setGesture(next);
  }

  function moveGesture(event: PointerEvent<HTMLButtonElement>) {
    if (pointerRef.current !== event.pointerId) return;
    setGesture(pointFromEvent(event));
  }

  function finishGesture(event: PointerEvent<HTMLButtonElement>) {
    if (pointerRef.current !== event.pointerId) return;
    const next = pointFromEvent(event);
    cancelGesture();
    if (canAdjust && next) onChange(next);
  }

  function nudge(x: number, y: number) {
    if (!canAdjust || !crop) return;
    cancelGesture();
    onChange({
      x: crop.width < 1 ? boundedPlacement(value.x + x) : value.x,
      y: crop.height < 1 ? boundedPlacement(value.y + y) : value.y,
    });
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && pointerRef.current !== null) {
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
      return;
    }
    const step = event.shiftKey ? 0.1 : 0.01;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    nudge(...direction);
  }

  return (
    <div className="focal-point-control">
      <div className="editor-field-label-row"><span>Crop position</span><InfoTooltip label="Crop position" content="Click or tap the image to center the crop on that point. Drag to adjust. Use arrow keys for small moves, Shift and an arrow for larger moves. Escape cancels a drag. Enter resets to center. The original image stays unchanged." /></div>
      <p className="sr-only" id={descriptionId}>
        Click or tap the image to center the crop on that point. Drag to adjust.
        Use arrow keys for small moves, Shift and an arrow for larger moves.
        Escape cancels a drag. Enter resets to center. The original image stays unchanged.
      </p>
      <div className="focal-point-images">
        <button
          aria-describedby={descriptionId}
          aria-label="Image focal point"
          aria-disabled={!canAdjust}
          className="focal-point-surface"
          onClick={(event) => { if (event.detail === 0 && canAdjust) onChange({ x: 0.5, y: 0.5 }); }}
          onKeyDown={handleKey}
          onPointerDown={startGesture}
          onPointerMove={moveGesture}
          onPointerUp={finishGesture}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={cancelGesture}
          ref={surfaceRef}
          style={loaded ? { width: `min(100%, ${22 * image.width / image.height}rem)` } : undefined}
          type="button"
        >
          <span className="focal-point-original">
            <img
              alt="Original image for crop placement"
              draggable={false}
              onError={() => { setFailedSrc(src); cancelGesture(); }}
              onLoad={(event) => {
                setFailedSrc(null);
                setImage({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              }}
              ref={imageRef}
              src={src}
            />
            {crop ? <span aria-hidden="true" className="focal-point-window" style={{
              left: `${crop.left * 100}%`, top: `${crop.top * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%`,
            }}><span className="focal-point-marker" /></span> : null}
          </span>
        </button>
        {crop ? <figure className="focal-point-preview">
          <img alt="Current crop preview" src={src} style={{ aspectRatio, objectPosition: focalObjectPosition(position.x, position.y) }} />
          <figcaption>Crop preview</figcaption>
        </figure> : null}
      </div>
      {failedSrc === src ? <p role="status" className="field-error">The image could not be loaded. Your saved placement is unchanged.</p> : null}
      {crop ? <p className="field-hint" role="status" aria-live="polite">
        Horizontal position: {Math.round(value.x * 100)}%. Vertical position: {Math.round(value.y * 100)}%.
        {crop.width === 1 && crop.height === 1 ? " The whole image fits; no crop adjustment is needed." : crop.width === 1 ? " Only vertical moves change this crop." : " Only horizontal moves change this crop."}
      </p> : null}
      <div className="focal-point-actions" role="group" aria-label="Adjust image crop">
        <Button disabled={!canAdjust || crop?.width === 1 || value.x <= 0} onClick={() => nudge(-0.05, 0)}>Move left</Button>
        <Button disabled={!canAdjust || crop?.width === 1 || value.x >= 1} onClick={() => nudge(0.05, 0)}>Move right</Button>
        <Button disabled={!canAdjust || crop?.height === 1 || value.y <= 0} onClick={() => nudge(0, -0.05)}>Move up</Button>
        <Button disabled={!canAdjust || crop?.height === 1 || value.y >= 1} onClick={() => nudge(0, 0.05)}>Move down</Button>
        <Button disabled={!canAdjust} onClick={() => { cancelGesture(); onChange({ x: 0.5, y: 0.5 }); }}>Reset to center</Button>
      </div>
    </div>
  );
}
