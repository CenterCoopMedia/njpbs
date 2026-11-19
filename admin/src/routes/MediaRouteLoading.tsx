import { Component, lazy, type ReactNode } from "react";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";

type MediaSecondaryModule = typeof import("./MediaSecondaryRoutes");
export type MediaSecondaryLoader = () => Promise<MediaSecondaryModule>;

class MediaSecondaryLoadError extends Error {
  constructor(originalError: unknown) {
    super("The deferred media workspace could not be loaded.", { cause: originalError });
    this.name = "MediaSecondaryLoadError";
  }
}

export function createMediaSecondarySurface(load: MediaSecondaryLoader) {
  return lazy(async () => {
    try {
      return { default: (await load()).MediaSecondarySurface };
    } catch (error) {
      throw new MediaSecondaryLoadError(error);
    }
  });
}

export class MediaSecondaryLoadBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
}, { error: unknown | null }> {
  state = { error: null as unknown | null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (!(this.state.error instanceof MediaSecondaryLoadError)) throw this.state.error;
    return this.props.fallback;
  }
}

export function MediaLoading() {
  return (
    <div className="media-loading">
      <LoadingIndicator
        label="Loading media library"
        layout="stack"
        stages={[
          "Asking the CMS for the first page of media",
          "Waiting for the media list",
        ]}
      />
    </div>
  );
}
