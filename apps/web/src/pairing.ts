/** Normalize a hub's pairing link, including links from hubs installed before the rename. */
export function pairingLink(input: string): string {
  const url = new URL(input);
  if (!["wisp:", "warren:"].includes(url.protocol) || url.hostname !== "pair" || (url.pathname && url.pathname !== "/")) throw new Error("Invalid Wisp pairing link");
  // Custom URL schemes are non-special URLs; assigning .protocol cannot change their scheme.
  return `wisp://pair${url.search}`;
}
