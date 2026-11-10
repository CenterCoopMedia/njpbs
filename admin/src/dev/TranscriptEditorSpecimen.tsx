import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TranscriptEditor } from "../components/TranscriptEditor";
import { Button } from "../components/ui/Primitives";
import { selectedPassageRange } from "../lib/transcript-workspace";
import { mediaTranscriptFixture } from "./fixtures/media-transcript";
import "../styles.css";
import "../cms-workspace.css";
import "../components/VideoProductionTools.css";
import "./TranscriptEditorSpecimen.css";

function Specimen() {
  const [response, setResponse] = useState(mediaTranscriptFixture);
  const [clip, setClip] = useState("");
  return <main className="transcript-specimen">
    <h1>Waterfront oral history · synthetic 90-minute transcript</h1>
    <p>Real TranscriptEditor with synthetic responses. Range selection sets fields only. No media or service requests.</p>
    <div className="transcript-specimen-layout">
      <aside><h2>Source context</h2><p>90 minutes · 180 separate passages</p><p>Includes a 0.18-second fragment, long turns, separate unknown voices and long speaker names.</p><output aria-label="Clip fields">{clip || "No clip range set"}</output></aside>
      <div className="transcript-specimen-owner">
        <TranscriptEditor response={response} canEdit disabled={false} onSeek={() => {}}
          onSelectPassage={segment => setClip(`${segment.startSeconds} to ${segment.endSeconds}`)}
          canSelectPassage={segment => !!selectedPassageRange([segment], new Set([segment.index ?? 0])) && segment.endSeconds <= 5400}
          onSave={async edits => ({ ...response, transcript: { ...response.transcript, editRevision: 8, speakerNames: { ...response.transcript.speakerNames, ...edits.speakerNames }, speakerRoles: { ...response.transcript.speakerRoles, ...edits.speakerRoles } }, segments: response.segments?.map(segment => ({ ...segment, ...edits.segments?.find(edit => edit.index === segment.index) })) })}
          onAlign={async () => ({ state: "not_requested", timingBasis: "viewing-copy-elapsed" })}
          onCancelAlignment={async () => ({ state: "cancelled", timingBasis: "viewing-copy-elapsed" })}
          onSaved={setResponse} onReload={() => setResponse(mediaTranscriptFixture())}
          onDirtyChange={() => {}} onSavingChange={() => {}} onEditingChange={() => {}} />
        {response.nextCursor ? <Button onClick={() => setResponse(mediaTranscriptFixture(180))}>Load more transcript</Button> : null}
      </div>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Specimen />);
