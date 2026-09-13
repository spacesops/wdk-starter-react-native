import {
  computePurchasePaymentOutputs,
  computeRevenueSplitOutputs,
  hasPurchaseRevenueSplit,
  PURCHASE_OUTPUT_MIN_SATS,
  resolvePurchasePaymentOutputs,
} from './compute-purchase-payment-outputs';

describe('computePurchasePaymentOutputs', () => {
  const taproot = 'bc1pplatformexample';
  const tenant = 'bc1ptenantexample';
  const affiliate = 'bc1paffiliateexample';

  it('sends full total to taproot when no tenant address', () => {
    const outputs = computePurchasePaymentOutputs({
      totalPriceSats: 152_768,
      taprootAddress: taproot,
    });
    expect(outputs).toEqual([{ address: taproot, valueSats: 152_768 }]);
  });

  it('allocates platform % of discounted price plus block fee to taproot', () => {
    const outputs = computePurchasePaymentOutputs({
      totalPriceSats: 100_000,
      discountedPriceSats: 80_000,
      blockFeeSats: 20_000,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
    });
    expect(outputs).toEqual([
      { address: taproot, valueSats: 24_000 },
      { address: tenant, valueSats: 76_000 },
    ]);
  });

  it('splits platform, affiliate, and tenant with floor math', () => {
    const total = 152_768;
    const discountedPrice = 127_500;
    const blockFee = 25_268;
    const outputs = computePurchasePaymentOutputs({
      totalPriceSats: total,
      discountedPriceSats: discountedPrice,
      blockFeeSats: blockFee,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 15,
    });

    const platformSats = Math.floor((discountedPrice * 5) / 100) + blockFee;
    const remaining = total - platformSats;
    const affiliateSats = Math.floor((remaining * 15) / 100);
    const tenantSats = remaining - affiliateSats;

    expect(outputs).toEqual([
      { address: taproot, valueSats: platformSats },
      { address: affiliate, valueSats: affiliateSats },
      { address: tenant, valueSats: tenantSats },
    ]);
    expect(outputs.reduce((s, o) => s + o.valueSats, 0)).toBe(total);
  });

  it('moves taproot dust to tenant and keeps affiliate split', () => {
    const total = 2_100;
    const resolution = resolvePurchasePaymentOutputs({
      totalPriceSats: total,
      discountedPriceSats: 2_000,
      blockFeeSats: 100,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 1,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 5,
    });

    expect(resolution.revenueSplitApplied).toBe(false);
    expect(resolution.outputs).toEqual([{ address: tenant, valueSats: total }]);
    expect(resolution.splitAdjustments?.some((note) => note.includes('tenant'))).toBe(true);
    expect(resolution.outputs.reduce((s, o) => s + o.valueSats, 0)).toBe(total);
  });

  it('merges affiliate dust into tenant when tenant had the larger share', () => {
    const total = 10_000;
    const resolution = resolvePurchasePaymentOutputs({
      totalPriceSats: total,
      discountedPriceSats: 9_500,
      blockFeeSats: 500,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 1,
    });

    expect(resolution.outputs).toEqual([
      { address: taproot, valueSats: 975 },
      { address: tenant, valueSats: 9_025 },
    ]);
    expect(resolution.splitAdjustments?.some((note) => note.includes('affiliate'))).toBe(true);
  });

  it('merges tenant dust into affiliate when affiliate had the larger share', () => {
    const total = 10_000;
    const resolution = resolvePurchasePaymentOutputs({
      totalPriceSats: total,
      discountedPriceSats: 9_500,
      blockFeeSats: 500,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 99,
    });

    expect(resolution.outputs).toEqual([
      { address: taproot, valueSats: 975 },
      { address: affiliate, valueSats: 9_025 },
    ]);
    expect(resolution.splitAdjustments?.some((note) => note.includes('tenant'))).toBe(true);
  });

  it('ends with a single output after taproot and affiliate dust redistribution', () => {
    const total = 500;
    const resolution = resolvePurchasePaymentOutputs({
      totalPriceSats: total,
      discountedPriceSats: 400,
      blockFeeSats: 100,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 95,
    });

    expect(resolution.revenueSplitApplied).toBe(false);
    expect(resolution.outputs).toEqual([{ address: affiliate, valueSats: total }]);
    expect(resolution.splitAdjustments?.length).toBeGreaterThan(0);
  });

  it('does not adjust splits when all outputs are above dust', () => {
    const resolution = resolvePurchasePaymentOutputs({
      totalPriceSats: 100_000,
      discountedPriceSats: 80_000,
      blockFeeSats: 20_000,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
    });

    expect(resolution.revenueSplitApplied).toBe(true);
    expect(resolution.splitAdjustments).toBeUndefined();
    expect(resolution.outputs).toHaveLength(2);
  });

  it('exposes raw split math via computeRevenueSplitOutputs', () => {
    const split = computeRevenueSplitOutputs({
      totalPriceSats: 10_000,
      discountedPriceSats: 9_900,
      blockFeeSats: 100,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 1,
    });
    expect(split).toEqual([
      { address: taproot, valueSats: 199 },
      { address: tenant, valueSats: 9_801 },
    ]);
    expect(split[0].valueSats).toBeLessThanOrEqual(PURCHASE_OUTPUT_MIN_SATS);
  });

  it('detects revenue split presence from tenant address', () => {
    expect(
      hasPurchaseRevenueSplit({ totalPriceSats: 1_000, taprootAddress: taproot })
    ).toBe(false);
    expect(
      hasPurchaseRevenueSplit({
        totalPriceSats: 1_000,
        taprootAddress: taproot,
        tenantPaymentAddress: tenant,
      })
    ).toBe(true);
  });

  it('splits platform top-level affiliate share from discounted price', () => {
    const total = 6_256;
    const discountedPrice = 5_000;
    const blockFee = 1_256;
    const outputs = computePurchasePaymentOutputs({
      totalPriceSats: total,
      discountedPriceSats: discountedPrice,
      blockFeeSats: blockFee,
      taprootAddress: taproot,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 15,
    });

    const affiliateSats = Math.floor((discountedPrice * 15) / 100);
    const platformSats = total - affiliateSats;

    expect(outputs).toEqual([
      { address: taproot, valueSats: platformSats },
      { address: affiliate, valueSats: affiliateSats },
    ]);
    expect(outputs.reduce((s, o) => s + o.valueSats, 0)).toBe(total);
  });

  it('detects revenue split for platform top-level affiliate coupon', () => {
    expect(
      hasPurchaseRevenueSplit({
        totalPriceSats: 6_256,
        taprootAddress: taproot,
        affiliatePaymentAddress: affiliate,
        affiliateRevenuePercent: 15,
      })
    ).toBe(true);
  });

  it('merges affiliate dust into platform on top-level split', () => {
    const total = 1_400;
    const resolution = resolvePurchasePaymentOutputs({
      totalPriceSats: total,
      discountedPriceSats: 200,
      blockFeeSats: 1_200,
      taprootAddress: taproot,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 15,
    });

    expect(resolution.outputs).toEqual([{ address: taproot, valueSats: total }]);
    expect(resolution.splitAdjustments?.some((note) => note.includes('affiliate'))).toBe(true);
  });
});
