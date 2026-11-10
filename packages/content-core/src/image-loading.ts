/** Only a trusted page assembler can select the page's LCP candidate. */
export type ImageLoadingPlacement = "content" | "lcp";

export interface ImageLoadingAttributes {
  readonly loading: "eager" | "lazy";
  readonly decoding: "async";
  readonly fetchpriority?: "high";
}

interface IntrinsicImage {
  width?: number;
  height?: number;
}

export type PageImageLoading = (
  image: IntrinsicImage | null | undefined,
  placement: ImageLoadingPlacement,
) => ImageLoadingAttributes;

export const lazyImageLoading: Readonly<ImageLoadingAttributes> = {
  loading: "lazy", decoding: "async",
};

/** Create once per page/request. Invalid candidates do not consume the slot. */
export function createPageImageLoading(): PageImageLoading {
  let priorityUsed = false;
  return (image, placement) => {
    if (placement !== "lcp" || priorityUsed
      || !Number.isSafeInteger(image?.width) || (image?.width ?? 0) <= 0
      || !Number.isSafeInteger(image?.height) || (image?.height ?? 0) <= 0) {
      return lazyImageLoading;
    }
    priorityUsed = true;
    return { loading: "eager", decoding: "async", fetchpriority: "high" };
  };
}
