export type PurchasePaymentOutput = {
  address: string;
  valueSats: number;
};

export type PurchaseSplitInput = {
  totalPriceSats: number;
  taprootAddress: string;
  tenantPaymentAddress?: string;
  platformRevenuePercent?: number;
  affiliatePaymentAddress?: string;
  affiliateRevenuePercent?: number;
};

/** Minimum non-dust output for purchase splits (matches typical P2TR dust). */
export const PURCHASE_OUTPUT_MIN_SATS = 330;

function assertPositiveInt(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer (sats)`);
  }
  return value;
}

function assertPercent(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be an integer from 0 to 100`);
  }
  return value;
}

function assertOutputAboveDust(output: PurchasePaymentOutput): PurchasePaymentOutput {
  if (output.valueSats <= PURCHASE_OUTPUT_MIN_SATS) {
    throw new Error(
      `Payment output to ${output.address} is ${output.valueSats} sats (below dust minimum ${PURCHASE_OUTPUT_MIN_SATS})`
    );
  }
  return output;
}

/**
 * Computes purchase payment outputs from POST purchase response split fields.
 *
 * - No tenant address: full total to taproot (current behavior).
 * - With tenant: platform % of total to taproot; remainder to tenant and/or affiliate.
 * - Percents use Math.floor; tenant receives the final remainder.
 */
export function computePurchasePaymentOutputs(input: PurchaseSplitInput): PurchasePaymentOutput[] {
  const total = assertPositiveInt('totalPriceSats', input.totalPriceSats);
  const taprootAddress = input.taprootAddress?.trim();
  if (!taprootAddress) {
    throw new Error('taprootAddress is required');
  }

  const tenantAddress = input.tenantPaymentAddress?.trim();
  if (!tenantAddress) {
    return [assertOutputAboveDust({ address: taprootAddress, valueSats: total })];
  }

  const platformPercent = assertPercent(
    'platformRevenuePercent',
    input.platformRevenuePercent ?? 0
  );
  const platformSats = Math.floor((total * platformPercent) / 100);
  let remaining = total - platformSats;

  const affiliateAddress = input.affiliatePaymentAddress?.trim();
  const outputs: PurchasePaymentOutput[] = [];

  if (platformSats > 0) {
    outputs.push({ address: taprootAddress, valueSats: platformSats });
  }

  if (!affiliateAddress) {
    outputs.push({ address: tenantAddress, valueSats: remaining });
  } else {
    const affiliatePercent = assertPercent(
      'affiliateRevenuePercent',
      input.affiliateRevenuePercent ?? 0
    );
    const affiliateSats = Math.floor((remaining * affiliatePercent) / 100);
    const tenantSats = remaining - affiliateSats;

    if (affiliateSats > 0) {
      outputs.push({ address: affiliateAddress, valueSats: affiliateSats });
    }
    if (tenantSats > 0) {
      outputs.push({ address: tenantAddress, valueSats: tenantSats });
    }
  }

  const sum = outputs.reduce((acc, o) => acc + o.valueSats, 0);
  if (sum !== total) {
    throw new Error(`Purchase outputs sum to ${sum} sats but total is ${total} sats`);
  }

  if (outputs.length === 0) {
    throw new Error('No payment outputs produced for purchase split');
  }

  return outputs.map(assertOutputAboveDust);
}

export function hasPurchaseRevenueSplit(input: PurchaseSplitInput): boolean {
  return Boolean(input.tenantPaymentAddress?.trim());
}
