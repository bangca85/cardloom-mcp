// Synthetic fixture: no real behaviour.
export function postEntry(accountId: string, amountMinor: bigint, seq: number): string {
  return `${accountId}:${seq}:${amountMinor}`;
}
