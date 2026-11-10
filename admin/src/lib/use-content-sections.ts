// The live content section registry, for every admin surface that has to offer the
// finite list of editorial desks: the Staff access grant picker (#619) and the record
// create form's section control (#845).
//
// One hook rather than a subscription per component, because the two surfaces must not
// be able to disagree about what the desks are -- a grant written against a desk the
// record form does not offer would scope a person to work they can never create.
//
// A live Firestore read rather than a build-time table: adding a desk is a data change,
// so it has to appear without a redeploy. Failure falls back to the seeded desks instead
// of emptying the control, which keeps grants and creates working while the read is
// broken; the server revalidates every section name against the registry anyway, so the
// fallback can never authorize or create a desk that does not exist.

import { collection, limit, onSnapshot, query } from "firebase/firestore";
import { SECTION_LISTENER_LIMIT } from "./listener-limits";
import { useEffect, useState } from "react";
import { db } from "./firebase";
import {
  CONTENT_SECTIONS_COLLECTION,
  SEEDED_CONTENT_SECTIONS,
  parseContentSectionDefinition,
  sortContentSections,
  type ContentSectionDefinition,
} from "../../../packages/content-core/src/content-sections";

export function seededContentSections(): ContentSectionDefinition[] {
  return sortContentSections([...SEEDED_CONTENT_SECTIONS]);
}

/** The minimum of a Firestore document snapshot this parser reads. */
export interface RegistryDocSnapshot {
  id: string;
  data: () => unknown;
}

/**
 * Parse the registry collection snapshot into the desks a picker may offer.
 *
 * Registration is document existence: the server reads the `sections` collection and
 * accepts a section name only if a document is keyed by it. The document id is therefore
 * the only id that means anything, and a payload `id` field that disagrees with it is a
 * mislabelled row -- letting the payload win would put a value in front of staff that the
 * server will reject on the save. The document id is authoritative here, and the payload's
 * own `id` is dropped before parsing rather than blended with it.
 */
export function parseContentSectionSnapshot(
  docs: readonly RegistryDocSnapshot[],
): ContentSectionDefinition[] {
  const parsed: ContentSectionDefinition[] = [];
  for (const sectionDoc of docs) {
    const data = sectionDoc?.data?.();
    const fields =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    const entry = parseContentSectionDefinition({
      ...fields,
      id: sectionDoc.id,
    });
    if (entry !== null) parsed.push(entry);
  }
  return sortContentSections(parsed);
}

export function useContentSections(): ContentSectionDefinition[] {
  return useContentSectionRegistry().sections;
}

export function useContentSectionRegistry() {
  const [sections, setSections] =
    useState<ContentSectionDefinition[]>(seededContentSections);

  const [ready, setReady] = useState(false);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, CONTENT_SECTIONS_COLLECTION), limit(SECTION_LISTENER_LIMIT + 1)),
      (snapshot) => {
        // Read the snapshot defensively. This callback runs inside a React effect, so a
        // snapshot that is not the collection shape this expects would throw where nothing
        // can catch it and take the editor down with it. Falling through to the seeded
        // desks is the same answer a failed read already gets.
        const docs = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
        if (!Array.isArray(snapshot?.docs) || docs.length > SECTION_LISTENER_LIMIT) {
          setSections(seededContentSections());
          setReady(false);
          return;
        }
        const parsed = parseContentSectionSnapshot(docs);
        // An empty or entirely malformed registry keeps the seeded desks rather than
        // leaving a required picker with nothing to choose.
        if (parsed.length > 0) setSections(parsed);
        setReady(true);
      },
      () => {
        setSections(seededContentSections());
        setReady(false);
      },
    );
  }, []);

  return { sections, ready };
}
