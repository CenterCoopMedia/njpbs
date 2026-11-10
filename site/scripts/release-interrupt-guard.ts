/** SIGINT and SIGTERM must not end a release command while its build child
 * runs: the child ignores both signals, and the checkout lock of the wrapper
 * ends with the command. The command stops at its next safe point instead. */
export function installInterruptGuard(
  target: Pick<NodeJS.Process, "on"> = process,
  report: (message: string) => void = (message) => { process.stderr.write(message); },
): () => boolean {
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    target.on(signal, () => {
      interrupted = true;
      report("Cloud release interrupted: it stops at the next safe point and keeps the checkout lock until then\n");
    });
  }
  return () => interrupted;
}
