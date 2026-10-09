/** Polling intervals aligned to real purchase / commitment timelines. */

export const FREE_COUPON_POLL_MS = 3 * 60 * 1000;
export const PRE_STAGED_POLL_MS = 30 * 60 * 1000;
export const STAGED_PLUS_POLL_MS = 60 * 60 * 1000;
export const ERROR_RETRY_CAP_MS = 5 * 60 * 1000;
export const MAX_POLL_ATTEMPTS = 168;

/** Minimum active poll delay before slowing UI countdown ticks (ms). */
export const SLOW_UI_TICK_THRESHOLD_MS = 5 * 60 * 1000;

export type PurchasePollingPhase = 'free_coupon_early' | 'pre_staged' | 'staged_plus';

export type PurchasePollingContext = {
  unifiedStatus: string | null;
  subsHandleStatus: string | null;
  /** Persisted on My Spaces rows for completely-free coupon purchases. */
  isFreeCouponPurchase?: boolean;
};

const STAGED_OR_COMMITTED = new Set(['staged', 'committed']);

const UNIFIED_STAGED_PLUS = new Set([
  'proof_created',
  'proof_batched',
  'proof_committed',
  'certificate_pending',
  'certificate_delivered',
  'sptr_creating',
  'sptr_created',
  'sptr_delivered',
]);

function normalizeStatus(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Resolve polling phase from latest unified + SUBS status snapshot. */
export function resolvePurchasePollingPhase(ctx: PurchasePollingContext): PurchasePollingPhase {
  const unified = normalizeStatus(ctx.unifiedStatus);
  const subs = normalizeStatus(ctx.subsHandleStatus);

  if (subs && STAGED_OR_COMMITTED.has(subs)) {
    return 'staged_plus';
  }
  if (unified && UNIFIED_STAGED_PLUS.has(unified)) {
    return 'staged_plus';
  }

  const isFreeCoupon =
    ctx.isFreeCouponPurchase === true || unified === 'requesting';

  if (isFreeCoupon) {
    return 'free_coupon_early';
  }

  return 'pre_staged';
}

export function getPollingIntervalMs(phase: PurchasePollingPhase): number {
  switch (phase) {
    case 'free_coupon_early':
      return FREE_COUPON_POLL_MS;
    case 'pre_staged':
      return PRE_STAGED_POLL_MS;
    case 'staged_plus':
      return STAGED_PLUS_POLL_MS;
    default:
      return PRE_STAGED_POLL_MS;
  }
}

export function getPollingIntervalMsForContext(ctx: PurchasePollingContext): number {
  return getPollingIntervalMs(resolvePurchasePollingPhase(ctx));
}

/** Retry delay after a transient poll error (no exponential backoff). */
export function getPollingErrorRetryMs(ctx: PurchasePollingContext): number {
  const phaseInterval = getPollingIntervalMsForContext(ctx);
  return Math.min(phaseInterval, ERROR_RETRY_CAP_MS);
}

/**
 * Human-readable countdown for My Spaces third column (poll wait).
 * Pipeline finalized ETA uses `formatMySpacesThirdColumnLabel` in space-pipeline.ts.
 */
export function formatPollCountdownLabel(msRemaining: number): string {
  if (msRemaining <= 0) return '0 min';

  const totalMinutes = msRemaining / 60_000;
  if (totalMinutes >= 60) {
    const hours = Math.round((totalMinutes / 60) * 10) / 10;
    return hours === 1 ? '1 hr' : `${hours} hrs`;
  }

  const minutes = Math.round(totalMinutes * 10) / 10;
  return `${minutes} min`;
}
