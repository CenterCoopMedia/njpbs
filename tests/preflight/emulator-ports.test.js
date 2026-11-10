import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveFirebaseEmulatorConfig } from "../../scripts/firebase-emulator-config.mjs";

// A stale emulator process holding an emulator port is one of the two
// environmental causes #428 lists for a run that hangs after function discovery
// (the other being firebase-tools' Windows child-process behavior). The doc's
// fix is manual: netstat for the port, then kill the orphan. This guard automates
// the detection half. Like the param preflight, it has to run in the pretest
// phase, before `firebase emulators:exec` binds the ports itself: a check inside
// the functions suite would sit behind the very hang it is meant to preempt.
//
// test:functions runs `--only auth,firestore,functions`, so those three are the
// ports a leftover process would collide with. They are read from firebase.json
// so this guard cannot drift from the real config.
const EMULATORS_IN_USE = ["auth", "firestore", "functions"];
const FIREBASE_JSON = fileURLToPath(new URL("../../firebase.json", import.meta.url));

export function loadEmulatorConfig(env = process.env) {
  const config = JSON.parse(readFileSync(FIREBASE_JSON, "utf8"));
  return resolveFirebaseEmulatorConfig(config, env);
}

// Pull the {name, port} pairs for the requested emulators out of a firebase.json
// object. An emulator with no declared port is skipped rather than guessed at.
export function emulatorPortsInUse(config, only = EMULATORS_IN_USE) {
  const emulators = config?.emulators ?? {};
  const ports = [];
  for (const name of only) {
    const port = emulators?.[name]?.port;
    if (typeof port === "number") ports.push({ name, port });
  }
  return ports;
}

// A running emulator (or its java.exe) accepts TCP connections on its port, so a
// successful connect is the reliable "occupied" signal. A refused or timed-out
// connect is treated as free: the point is to flag a live listener, not to fail
// on a filtered or slow port and turn a helpful guard into a new source of hangs.
// createSocket is injectable so the resolution logic can be tested against a fake
// socket without opening a real one (some sandboxes forbid listen(), and the
// probe itself should never need a server anyway).
export function portIsAccepting(
  port,
  { host = "127.0.0.1", timeoutMs = 400, createSocket = () => new net.Socket() } = {},
) {
  return new Promise((resolve) => {
    const socket = createSocket();
    let settled = false;
    const done = (accepting) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(accepting);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

export function formatPortConflictMessage(conflicts) {
  const lines = conflicts.map(({ name, port }) => `  - ${name} emulator on port ${port}`);
  return [
    "An emulator port is already in use, most likely a leftover emulator process:",
    ...lines,
    "",
    "Stop the process holding the port before running the functions suite.",
  ].join("\n");
}

// The live guard. It probes the real config ports and is what fails a stalled
// local run fast with an actionable message. Skipped in CI: #428 is a local
// (Windows) failure mode -- Linux runners do not stall and start from free ports,
// and CI runs each emulators:exec step sequentially, so gating CI on a live port
// probe would add environmental flakiness with no upside. Emulator configuration
// and launcher behavior remain covered in firebase-emulator-config.test.js.
const liveGuard = it.skipIf(!!process.env.CI);

describe("emulator ports are free before the functions suite", () => {
  liveGuard("fails fast if a process is already holding an emulator port", async () => {
    const ports = emulatorPortsInUse(loadEmulatorConfig());
    const conflicts = [];
    for (const entry of ports) {
      if (await portIsAccepting(entry.port)) conflicts.push(entry);
    }
    if (conflicts.length > 0) {
      expect.fail(formatPortConflictMessage(conflicts));
    }
  });
});
