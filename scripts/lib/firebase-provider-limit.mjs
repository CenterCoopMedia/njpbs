import { networkFault } from "./network-fault.mjs";

const providerLimit = /Quota exceeded|Resource exhausted|HTTP Error: (?:429|5\d\d)/i;

/**
 * What to deploy after a failed Firebase deploy, or null when the log of that
 * attempt shows no provider limit and does not end on a lost connection: the
 * failure is then the source's or the account's, and repeating cannot change it.
 *
 * A repeat names the Functions the attempt left. An unnamed Function with
 * unchanged source is skipped, so a schedule or an invoker that failed after the
 * source was accepted would stay unset. A named one is always deployed. It
 * also runs with the provider quiet, so a fault that a limit hid shows itself.
 */
export function repeatAfterProviderLimit(log, only) {
  const error = log.split("\n").find(line => providerLimit.test(line))?.trim() ?? networkFault(log);
  if (!error) return null;
  const list = log.match(/Functions deploy had errors with the following functions:((?:\r?\n[ \t]+\S+\([\w-]+\))+)/)?.[1] ?? "";
  const left = [...list.matchAll(/(\S+)\([\w-]+\)/g)].map(match => match[1]);
  return { error, left, only: left.length ? left.map(name => `functions:${name}`).join(",") : only };
}
