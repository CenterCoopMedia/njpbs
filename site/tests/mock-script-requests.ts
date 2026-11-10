import type { Window as DOMWindow } from "happy-dom";

/** Keep real script URL assertions while explicitly disabling external loads.
 * Load events and vendor functions are supplied by each test, never a network.
 */
export function mockScriptRequests(): void {
  (window as unknown as DOMWindow).happyDOM.settings.disableJavaScriptFileLoading = true;
}
