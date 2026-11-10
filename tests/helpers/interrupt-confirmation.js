// Simulate process loss after the real Firestore claim transaction commits,
// before the confirmation owner can perform IO or record its outcome.
export function interruptConfirmation(firestore, ref) {
  return new Proxy(firestore, { get(target, property) {
    if (property !== "runTransaction") {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return async (...args) => {
      const result = await target.runTransaction(...args);
      const row = (await ref.get()).data();
      if (row?.attempts === 4 && row.claim) throw new Error("Process lost after final confirmation claim");
      return result;
    };
  } });
}
