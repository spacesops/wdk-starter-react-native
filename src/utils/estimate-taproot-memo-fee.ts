/** Matches @wdk/wallet-btc MIN_TX_FEE_SATS. */
export const MIN_BITCOIN_TX_FEE_SATS = 141;

/** Conservative default when Electrum fee estimate is unavailable. */
export const DEFAULT_FEE_RATE_SAT_VB = 2;

/**
 * Conservative miner-fee estimate for a 1-input Taproot send with OP_RETURN memo.
 * Used when WDK fee quote fails so we never treat payment-only as the full requirement.
 */
export function estimateTaprootMemoFeeSats(
  memo: string,
  feeRateSatVb: number = DEFAULT_FEE_RATE_SAT_VB
): number {
  const memoBytes = new TextEncoder().encode(memo).length;
  const opReturnVbytes = 1 + 1 + memoBytes;
  const baseVsize = 111;
  return Math.max(
    MIN_BITCOIN_TX_FEE_SATS,
    Math.ceil((baseVsize + opReturnVbytes) * feeRateSatVb)
  );
}

export function resolveTaprootPurchaseRequiredSats(
  paymentAmountSats: number,
  memo: string,
  quotedFeeSats: number | null | undefined
): {
  estimatedFeeSats: number;
  totalRequiredSats: number;
  feeSource: 'quote' | 'estimate';
} {
  const estimatedFeeSats =
    quotedFeeSats != null && quotedFeeSats > 0
      ? quotedFeeSats
      : estimateTaprootMemoFeeSats(memo);
  return {
    estimatedFeeSats,
    totalRequiredSats: paymentAmountSats + estimatedFeeSats,
    feeSource: quotedFeeSats != null && quotedFeeSats > 0 ? 'quote' : 'estimate',
  };
}
