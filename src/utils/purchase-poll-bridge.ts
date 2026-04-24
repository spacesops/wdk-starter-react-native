/**
 * Lets Subspace (Take on-chain) start the same My Spaces status poll when the Spaces
 * screen has registered a handler. If nothing is registered, resume on next focus
 * still works if `mySpaces` was persisted with `jobId` + `unifiedStatusPurchaseType`.
 */
export type PurchaseStatusPollRequest = {
  jobId: number;
  spaceName: string;
  subspace: string;
  unifiedStatusPurchaseType: 'subname' | 'pointer';
};

let onStart: ((p: PurchaseStatusPollRequest) => void) | null = null;

export function registerPurchaseStatusPollStarter(
  h: (p: PurchaseStatusPollRequest) => void
): () => void {
  onStart = h;
  return () => {
    onStart = null;
  };
}

export function requestPurchaseStatusPoll(p: PurchaseStatusPollRequest): void {
  onStart?.(p);
}
