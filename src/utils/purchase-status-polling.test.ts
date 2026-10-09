import {
  formatPollCountdownLabel,
  FREE_COUPON_POLL_MS,
  getPollingErrorRetryMs,
  getPollingIntervalMs,
  getPollingIntervalMsForContext,
  PRE_STAGED_POLL_MS,
  resolvePurchasePollingPhase,
  STAGED_PLUS_POLL_MS,
} from './purchase-status-polling';

describe('resolvePurchasePollingPhase', () => {
  it('returns free_coupon_early for requesting status', () => {
    expect(
      resolvePurchasePollingPhase({
        unifiedStatus: 'requesting',
        subsHandleStatus: null,
      })
    ).toBe('free_coupon_early');
  });

  it('returns free_coupon_early when isFreeCouponPurchase is set', () => {
    expect(
      resolvePurchasePollingPhase({
        unifiedStatus: 'processing',
        subsHandleStatus: null,
        isFreeCouponPurchase: true,
      })
    ).toBe('free_coupon_early');
  });

  it('returns pre_staged for paid processing before subs staged', () => {
    expect(
      resolvePurchasePollingPhase({
        unifiedStatus: 'processing',
        subsHandleStatus: null,
        isFreeCouponPurchase: false,
      })
    ).toBe('pre_staged');
  });

  it('returns staged_plus when subs is staged', () => {
    expect(
      resolvePurchasePollingPhase({
        unifiedStatus: 'confirmed',
        subsHandleStatus: 'staged',
      })
    ).toBe('staged_plus');
  });

  it('returns staged_plus when subs is committed', () => {
    expect(
      resolvePurchasePollingPhase({
        unifiedStatus: 'proof_committed',
        subsHandleStatus: 'committed',
      })
    ).toBe('staged_plus');
  });

  it('returns staged_plus for proof_created unified status', () => {
    expect(
      resolvePurchasePollingPhase({
        unifiedStatus: 'proof_created',
        subsHandleStatus: null,
      })
    ).toBe('staged_plus');
  });
});

describe('getPollingIntervalMs', () => {
  it('maps phases to expected intervals', () => {
    expect(getPollingIntervalMs('free_coupon_early')).toBe(FREE_COUPON_POLL_MS);
    expect(getPollingIntervalMs('pre_staged')).toBe(PRE_STAGED_POLL_MS);
    expect(getPollingIntervalMs('staged_plus')).toBe(STAGED_PLUS_POLL_MS);
  });

  it('resolves context to 3 min for legacy requesting row', () => {
    expect(
      getPollingIntervalMsForContext({
        unifiedStatus: 'requesting',
        subsHandleStatus: null,
      })
    ).toBe(FREE_COUPON_POLL_MS);
  });
});

describe('getPollingErrorRetryMs', () => {
  it('caps staged_plus retries at 5 minutes', () => {
    expect(
      getPollingErrorRetryMs({
        unifiedStatus: 'proof_created',
        subsHandleStatus: 'committed',
      })
    ).toBe(5 * 60 * 1000);
  });

  it('uses full free-coupon interval when under cap', () => {
    expect(
      getPollingErrorRetryMs({
        unifiedStatus: 'requesting',
        subsHandleStatus: null,
        isFreeCouponPurchase: true,
      })
    ).toBe(FREE_COUPON_POLL_MS);
  });
});

describe('formatPollCountdownLabel', () => {
  it('formats sub-hour waits in minutes', () => {
    expect(formatPollCountdownLabel(2.5 * 60 * 1000)).toBe('2.5 min');
  });

  it('formats hour-long waits in hours', () => {
    expect(formatPollCountdownLabel(60 * 60 * 1000)).toBe('1 hr');
    expect(formatPollCountdownLabel(90 * 60 * 1000)).toBe('1.5 hrs');
  });
});
