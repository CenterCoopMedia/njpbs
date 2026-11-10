/** Local opt-in fixture using the real Page editor; no CMS session or writes. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { BlockEditor } from "../components/BlockEditor";
import { createBlock } from "../lib/block-factory";
import "../styles.css";
import "../cms-workspace.css";

function Specimen() {
  const [message, setMessage] = useState("");
  return <main style={{ maxWidth: 1160, margin: "0 auto", padding: 24 }}>
    <h1>Town lookup Page editor</h1><p>Local fixture. Saves stay in this browser session.</p>
    <BlockEditor section="genericPage" initialBlocks={[createBlock("town_lookup", "town-lookup-fixture")]}
      commandsInline allowIncomplete onSave={blocks => setMessage(`Saved ${blocks.length} planks locally.`)} />
    <p role="status">{message}</p>
  </main>;
}
createRoot(document.getElementById("town-lookup-root")!).render(<Specimen />);
