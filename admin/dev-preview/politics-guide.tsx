import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { PoliticsResourceRoute } from "../src/routes/PoliticsResourceRoute";
import "../src/styles.css";
import "./politics-guide.css";

// Same-origin requests use the real Dev gateway cookie. This page neither
// invents a CMS identity nor requests a Firebase token or production API.
const load = (name: string) => async (signal: AbortSignal): Promise<unknown> => {
  const response = await fetch(`/resources/nj-politics/_preview/${name}.json`, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("The private Dev resource is unavailable.");
  return response.json();
};
const previewSource = { politics: load("nj-politics"), elections: load("nj-election-2026") };
const target = document.getElementById("nj-politics-dev-preview");
if (!target) throw new Error("The private Dev guide root is missing.");
createRoot(target).render(<BrowserRouter><PoliticsResourceRoute previewSource={previewSource} /></BrowserRouter>);
