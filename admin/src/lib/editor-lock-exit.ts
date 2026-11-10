import { getToken } from "firebase/app-check";
import { ensureAppCheck, auth, firebaseConfig, firestoreRestOrigin } from "./firebase";
import { editorLockContentAddress, editorLockDocumentId } from "./editor-locks";

export async function prepareEditorLockExitRelease(
  surfaceKey: string,
  actorId: string,
  sessionId: string,
): Promise<() => void> {
  const address = editorLockContentAddress(surfaceKey);
  const user = auth.currentUser;
  if (!address || !user || user.uid !== actorId) {
    throw new Error("Editor lease owner is unavailable.");
  }
  const [idToken, protection] = await Promise.all([
    user.getIdToken(),
    (() => {
      const instance = ensureAppCheck();
      return instance ? getToken(instance) : null;
    })(),
  ]);
  const database = `projects/${firebaseConfig.projectId}/databases/(default)`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${idToken}`,
  };
  if (protection) headers["X-Firebase-AppCheck"] = protection.token;
  const body = JSON.stringify({
    writes: [{
      update: {
        name: `${database}/documents/cmsEditorLocks/${editorLockDocumentId(surfaceKey)}`,
        fields: Object.fromEntries(
          Object.entries({ surfaceKey, ...address, ownerId: actorId, sessionId })
            .map(([name, value]) => [name, { stringValue: value }]),
        ),
      },
      updateTransforms: [{ fieldPath: "releasedAt", setToServerValue: "REQUEST_TIME" }],
      currentDocument: { exists: true },
    }],
  });
  return () => {
    if (auth.currentUser !== user) return;
    // Firebase ID tokens keep this write under the same Firestore rules as the SDK.
    // Those rules require the exact owner and session, so a delayed exit cannot release
    // a newer lease. A crash/offline exit still falls back to the existing lease expiry.
    void fetch(`${firestoreRestOrigin}/v1/${database}/documents:commit`, {
      method: "POST",
      headers,
      body,
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  };
}
