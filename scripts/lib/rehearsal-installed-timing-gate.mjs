const refuse = () => { throw new Error('Installed development timing setup refused'); };

/** Gate the actual timing boundaries on completed read-only installed proof.
 * A failed, superseded or closed observation never grants source admission.
 */
export function bindInstalledTimingSetup({ firestore, store, ingress, dispatch, verifyInstalled, assertCurrent }) {
  let ready = false, closed = false, observation = 0;
  const current = (requireReady = false) => {
    assertCurrent();
    if (closed || requireReady && !ready) refuse();
  };
  const setup = Object.freeze({
    firestore,
    store: Object.freeze({ async get(key) { current(true); return store.get(key); } }),
    ingress: Object.freeze({ async prove(...args) { current(true); return ingress.prove(...args); } }),
    async assertInstalled(pair) {
      const attempt = ++observation;
      ready = false; current();
      await verifyInstalled(pair);
      current();
      if (attempt !== observation) refuse();
      ready = true;
    },
    async dispatch(...args) { current(true); return dispatch(...args); },
  });
  return { setup, close() { closed = true; ready = false; observation++; } };
}
