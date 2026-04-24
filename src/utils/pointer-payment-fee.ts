/**
 * Pointer (SPTR) on-chain payment tx: Taproot send + OP_RETURN memo — fixed weight for UI fee estimate.
 * (~227 B serialized; feerate uses weight → **176 vB** for this shape.)
 */
export const POINTER_PAYMENT_TX_VBYTES = 176;

/** Extra headroom so displayed fee stays above typical mempool drift / rounding. */
const CONSERVATIVE_FEE_MULTIPLIER = 1.2;

const MIN_FEERATE_SAT_VB = 1;

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Extract sat/vB feerate from Spaces / SUBSD JSON (field names vary by stack).
 */
export function extractFeerateSatPerVbFromJson(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const direct =
    numOrNull(o.feerate_sat_vb) ??
    numOrNull(o.feerateSatPerVb) ??
    numOrNull(o.fee_rate_sat_vb) ??
    numOrNull(o.feeRateSatPerVb) ??
    numOrNull(o.sat_per_vbyte) ??
    numOrNull(o.satPerVbyte) ??
    numOrNull(o.feerate) ??
    numOrNull((o.estimatefee as Record<string, unknown> | undefined)?.feerate_sat_vb) ??
    numOrNull((o.fee_estimate as Record<string, unknown> | undefined)?.feerate_sat_vb);
  if (direct != null) return direct;

  const blocks = o.blocks;
  if (blocks && typeof blocks === 'object') {
    const b1 = (blocks as Record<string, unknown>)['1'];
    if (b1 && typeof b1 === 'object') {
      const nested = numOrNull((b1 as Record<string, unknown>).feerate_sat_vb);
      if (nested != null) return nested;
    }
  }
  return null;
}

/** Network fee only (not the pointer price paid to recipient). */
export function conservativePointerPaymentFeeSats(feeRateSatPerVb: number): number {
  const rate = Math.max(MIN_FEERATE_SAT_VB, feeRateSatPerVb);
  return Math.ceil(POINTER_PAYMENT_TX_VBYTES * rate * CONSERVATIVE_FEE_MULTIPLIER);
}
