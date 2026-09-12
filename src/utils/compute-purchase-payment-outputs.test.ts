import {
  computePurchasePaymentOutputs,
  hasPurchaseRevenueSplit,
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

  it('splits platform and tenant when no affiliate', () => {
    const outputs = computePurchasePaymentOutputs({
      totalPriceSats: 100_000,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
    });
    expect(outputs).toEqual([
      { address: taproot, valueSats: 5_000 },
      { address: tenant, valueSats: 95_000 },
    ]);
  });

  it('splits platform, affiliate, and tenant with floor math', () => {
    const total = 152_768;
    const outputs = computePurchasePaymentOutputs({
      totalPriceSats: total,
      taprootAddress: taproot,
      tenantPaymentAddress: tenant,
      platformRevenuePercent: 5,
      affiliatePaymentAddress: affiliate,
      affiliateRevenuePercent: 15,
    });

    const platformSats = Math.floor((total * 5) / 100);
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
});
