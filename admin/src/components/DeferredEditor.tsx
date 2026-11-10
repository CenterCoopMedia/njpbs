import { Component, createRef, Suspense, type ComponentType, type ReactNode } from "react";
import { Button } from "./ui/Primitives";

class DeferredEditorBoundary extends Component<{
  label: string; retry: () => void; children: ReactNode;
}, { failed: boolean; retried: boolean }> {
  state = { failed: false, retried: false };
  private alert = createRef<HTMLDivElement>();
  componentDidUpdate(_previous: Readonly<typeof this.props>, state: Readonly<typeof this.state>) {
    if (this.state.failed && !state.failed) this.alert.current?.focus({ preventScroll: true });
  }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" tabIndex={-1} ref={this.alert}>
      <p>{this.props.label} could not open. Your document is still open.</p>
      {this.state.retried ? <p>Save your changes before reloading to try again.</p> : <Button onClick={() => { this.props.retry(); this.setState({ failed: false, retried: true }); }}>Retry {this.props.label.toLowerCase()}</Button>}
    </div>;
  }
}

/** A secondary editor can fail or retry without unmounting the document owner. */
export function deferEditor<Props extends object>(load: () => Promise<ComponentType<Props>>, label: string) {
  let Loaded: ComponentType<Props> | undefined;
  let request: Promise<void> | undefined;
  let failed = false;
  let failure: unknown;
  let demanded = false;
  const preload = () => request ??= Promise.resolve().then(load).then(value => { Loaded = value; }, error => {
    if (demanded) { failed = true; failure = error; }
    else request = undefined;
  });
  const retry = () => { request = undefined; failed = false; failure = undefined; demanded = false; };
  function Content(props: Props) {
    if (failed) throw failure;
    if (!Loaded) { demanded = true; throw preload(); }
    return <Loaded {...props} />;
  }
  function Editor(props: Props) {
    return <DeferredEditorBoundary label={label} retry={retry}>
      <Suspense fallback={<p role="status">Opening {label.toLowerCase()}…</p>}><Content {...props} /></Suspense>
    </DeferredEditorBoundary>;
  }
  return { Editor, preload };
}
