export function workerReadbackClock() {
  let elapsed = 0;
  return { now: () => elapsed, wait: async ms => { elapsed += ms; } };
}
