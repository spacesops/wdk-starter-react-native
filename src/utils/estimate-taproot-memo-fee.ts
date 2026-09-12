/** Matches @wdk/wallet-btc MIN_TX_FEE_SATS. */
export const MIN_BITCOIN_TX_FEE_SATS = 141;

/** Conservative default when Electrum fee estimate is unavailable. */
export const DEFAULT_FEE_RATE_SAT_VB = 2;

/**
 * Conservative miner-fee estimate for a 1-input Taproot send with OP_RETURN memo.
 * Used when WDK fee quote fails so we never treat payment-only as the full requirement.
 */
/** Approximate vsize of an additional P2TR payment output beyond the first. */
export const EXTRA_P2TR_PAYMENT_OUTPUT_VBYTES = 43;

export function estimateTaprootMemoFeeSats(
  memo: string,
  feeRateSatVb: number = DEFAULT_FEE_RATE_SAT_VB,
  extraPaymentOutputCount: number = 0
): number {
  const memoBytes = new TextEncoder().encode(memo).length;
  const opReturnVbytes = 1 + 1 + memoBytes;
  const baseVsize = 111;
  const extraOutputsVbytes =
    Math.max(0, extraPaymentOutputCount) * EXTRA_P2TR_PAYMENT_OUTPUT_VBYTES;
  return Math.max(
    MIN_BITCOIN_TX_FEE_SATS,
    Math.ceil((baseVsize + opReturnVbytes + extraOutputsVbytes) * feeRateSatVb)
  );
}

export function resolveTaprootPurchaseRequiredSats(
  paymentAmountSats: number,
  memo: string,
  quotedFeeSats: number | null | undefined,
  extraPaymentOutputCount: number = 0
): {
  estimatedFeeSats: number;
  totalRequiredSats: number;
  feeSource: 'quote' | 'estimate';
} {
  const estimatedFeeSats =
    quotedFeeSats != null && quotedFeeSats > 0
      ? quotedFeeSats
      : estimateTaprootMemoFeeSats(memo, DEFAULT_FEE_RATE_SAT_VB, extraPaymentOutputCount);
  return {
    estimatedFeeSats,
    totalRequiredSats: paymentAmountSats + estimatedFeeSats,
    feeSource: quotedFeeSats != null && quotedFeeSats > 0 ? 'quote' : 'estimate',
  };
}
