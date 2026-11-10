import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { ContentQuickActionsProvider } from "./context/ContentQuickActionsContext";
import { installPointerFocusTracking } from "./lib/input-modality";
import { initConsoleCapture } from "./lib/console-capture";
import { publishPerfProbe } from "./lib/perf-receipts";
import "./styles.css";

// The receipt module marks bootstrap when it is evaluated, which is before any instrumented
// code runs (#1064). The probe exposes sanitized categories and durations plus the narrow editor
// lease-release control required to measure a real reload without leaving a stale courtesy lock.
publishPerfProbe();
initConsoleCapture();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

installPointerFocusTracking();

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <ContentQuickActionsProvider>
        <App />
      </ContentQuickActionsProvider>
    </AuthProvider>
  </StrictMode>,
);
