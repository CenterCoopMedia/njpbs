export interface FocalPlacement {
  x: number;
  y: number;
}

export interface CropWindow {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function boundedPlacement(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

// Stored coordinates are CSS object-position, not coordinates on the source image.
// The window uses the same percent rounding as the public photo renderer.
export function cropWindow(
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number,
  placement: FocalPlacement,
): CropWindow | null {
  if (![sourceWidth, sourceHeight, aspectRatio].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  const sourceRatio = sourceWidth / sourceHeight;
  const width = Math.min(1, aspectRatio / sourceRatio);
  const height = Math.min(1, sourceRatio / aspectRatio);
  return {
    left: (1 - width) * boundedPlacement(placement.x),
    top: (1 - height) * boundedPlacement(placement.y),
    width,
    height,
  };
}

export function placementAtPoint(
  point: FocalPlacement,
  crop: CropWindow,
  current: FocalPlacement,
): FocalPlacement {
  return {
    x: crop.width < 1 ? boundedPlacement((point.x - crop.width / 2) / (1 - crop.width)) : current.x,
    y: crop.height < 1 ? boundedPlacement((point.y - crop.height / 2) / (1 - crop.height)) : current.y,
  };
}
