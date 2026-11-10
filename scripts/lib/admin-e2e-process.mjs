import { once } from "node:events";

const OUTPUT_TAIL_LENGTH = 512;

export class AdminE2ETerminationError extends Error {
  constructor(signal) {
    super("Admin E2E stopped by a termination signal.");
    this.name = "AdminE2ETerminationError";
    this.signal = signal;
  }
}

export function createStreamOutputGuard(assertOutput) {
  const tails = new Map();
  return (stream, chunk) => {
    const candidate = (tails.get(stream) ?? "") + chunk.toString("utf8");
    assertOutput(candidate);
    tails.set(stream, candidate.slice(-OUTPUT_TAIL_LENGTH));
  };
}

export async function forwardSignalAndWait(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (!child.kill(signal)) {
    throw new Error("Admin E2E could not forward the termination signal.");
  }
  await exited;
}

export function waitForOwnedPreview({
  child,
  origin,
  expectedStatusBody,
  fetchFn = fetch,
  timeoutMs = 30_000,
}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return Promise.reject(new Error("Admin E2E preview has no process id."));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let outputTail = "";
    let verifying = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", onOutput);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onError = () => finish(new Error("Admin E2E preview could not start."));
    const onExit = () => finish(new Error("Admin E2E preview exited before readiness."));
    const onOutput = (chunk) => {
      outputTail = (outputTail + chunk.toString("utf8")).slice(-1024);
      if (verifying || !outputTail.includes(`${origin}/`)) return;
      verifying = true;
      void (async () => {
        try {
          const response = await fetchFn(
            `${origin}/admin-status.json?admin-e2e-preview=1`,
            { cache: "no-store", redirect: "manual" },
          );
          const body = await response.text();
          if (
            !response.ok ||
            response.status !== 200 ||
            body !== expectedStatusBody ||
            child.exitCode !== null ||
            child.signalCode !== null
          ) {
            throw new Error("Admin E2E preview identity did not match the build.");
          }
          finish();
        } catch {
          finish(new Error("Admin E2E preview identity did not match the build."));
        }
      })();
    };
    const timer = setTimeout(
      () => finish(new Error("Admin E2E preview did not become ready.")),
      timeoutMs,
    );
    child.stdout.on("data", onOutput);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
