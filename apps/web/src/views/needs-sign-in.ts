import type { HarnessSettings } from "@wisp/core";

/** The settings of an AI tool whose default account isn't known to be signed in on the device, or null when it is (or isn't in the list). */
export function signInFor(list: HarnessSettings[], id: string): HarnessSettings | null {
  const s = list.find((x) => x.harness === id);
  const account = s && (s.accounts.find((a) => a.isDefault) ?? s.accounts[0]);
  return s && account && account.signedIn !== true ? s : null;
}
