export type PurchasePaymentOutput = {
  address: string;
  valueSats: number;
};

export type PurchaseSplitInput = {
  totalPriceSats: number;
  /** Subname price after coupon; excludes block_fee. Platform % applies to this amount only. */
  discountedPriceSats?: number;
  /** Confirmation-target block fee in the payment total (allocated to platform). */
  blockFeeSats?: number;
  taprootAddress: string;
  tenantPaymentAddress?: string;
  platformRevenuePercent?: number;
  affiliatePaymentAddress?: string;
  affiliateRevenuePercent?: number;
};

export type PurchasePaymentOutputsResult = {
  outputs: PurchasePaymentOutput[];
  /** True when multiple payment outputs are used (revenue split applied). */
  revenueSplitApplied: boolean;
  /** Human-readable notes when dust redistribution altered the proposed split. */
  splitAdjustments?: string[];
  /** Raw split outputs before dust redistribution (for logging). */
  attemptedSplitOutputs?: PurchasePaymentOutput[];
};

/** Minimum non-dust output for purchase splits (matches wdk-wallet-btc P2TR dust limit). */
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

function assertNonNegativeInt(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a non-negative integer (sats)`);
  }
  return value;
}

/** Subname price after coupon discount (block_fee is never discounted). */
export function resolvePurchaseDiscountedPriceSats(
  priceSats: number,
  discountPercent: number | null | undefined
): number {
  if (discountPercent === null || discountPercent === undefined) {
    return priceSats;
  }
  return Math.floor((priceSats * (100 - discountPercent)) / 100);
}

/**
 * Platform share = floor(discountedPrice × platform%) + block_fee.
 * Remainder (including any bundled pointer amounts) goes to tenant and/or affiliate.
 */
function resolvePlatformAndRemaining(input: PurchaseSplitInput): {
  platformSats: number;
  remaining: number;
} {
  const total = assertPositiveInt('totalPriceSats', input.totalPriceSats);
  const platformPercent = assertPercent(
    'platformRevenuePercent',
    input.platformRevenuePercent ?? 0
  );

  if (input.discountedPriceSats !== undefined && input.blockFeeSats !== undefined) {
    const discountedPrice = assertPositiveInt('discountedPriceSats', input.discountedPriceSats);
    const blockFee = assertNonNegativeInt('blockFeeSats', input.blockFeeSats);
    if (discountedPrice + blockFee > total) {
      throw new Error(
        `discountedPriceSats (${discountedPrice}) + blockFeeSats (${blockFee}) cannot exceed totalPriceSats (${total})`
      );
    }
    const platformShareOfPrice = Math.floor((discountedPrice * platformPercent) / 100);
    const platformSats = platformShareOfPrice + blockFee;
    const remaining = total - platformSats;
    if (remaining < 0) {
      throw new Error(`Platform share ${platformSats} sats exceeds total ${total} sats`);
    }
    return { platformSats, remaining };
  }

  const platformSats = Math.floor((total * platformPercent) / 100);
  return { platformSats, remaining: total - platformSats };
}

function assertOutputAboveDust(output: PurchasePaymentOutput): PurchasePaymentOutput {
  if (output.valueSats <= PURCHASE_OUTPUT_MIN_SATS) {
    throw new Error(
      `Payment output to ${output.address} is ${output.valueSats} sats (below dust minimum ${PURCHASE_OUTPUT_MIN_SATS})`
    );
  }
  return output;
}

function isOutputBelowDust(valueSats: number): boolean {
  return valueSats > 0 && valueSats <= PURCHASE_OUTPUT_MIN_SATS;
}

function mergeOutputsByAddress(outputs: PurchasePaymentOutput[]): PurchasePaymentOutput[] {
  const totals = new Map<string, number>();
  for (const output of outputs) {
    totals.set(output.address, (totals.get(output.address) ?? 0) + output.valueSats);
  }
  return [...totals.entries()]
    .filter(([, valueSats]) => valueSats > 0)
    .map(([address, valueSats]) => ({ address, valueSats }));
}

/**
 * Affiliate share of discounted subname price (platform top-level spaces, no tenant).
 * Platform receives total − affiliate (remainder of price + block_fee).
 */
function resolveTopLevelAffiliateShare(input: PurchaseSplitInput): number {
  const affiliatePercent = assertPercent(
    'affiliateRevenuePercent',
    input.affiliateRevenuePercent ?? 0
  );

  if (input.discountedPriceSats !== undefined) {
    const discountedPrice = assertPositiveInt('discountedPriceSats', input.discountedPriceSats);
    return Math.floor((discountedPrice * affiliatePercent) / 100);
  }

  const total = assertPositiveInt('totalPriceSats', input.totalPriceSats);
  return Math.floor((total * affiliatePercent) / 100);
}

function computeTopLevelAffiliateSplitOutputs(input: PurchaseSplitInput): PurchasePaymentOutput[] {
  const total = assertPositiveInt('totalPriceSats', input.totalPriceSats);
  const taprootAddress = input.taprootAddress?.trim();
  const affiliateAddress = input.affiliatePaymentAddress?.trim();
  if (!taprootAddress || !affiliateAddress) {
    throw new Error('taprootAddress and affiliatePaymentAddress are required');
  }

  const affiliateSats = resolveTopLevelAffiliateShare(input);
  const platformSats = total - affiliateSats;

  const outputs: PurchasePaymentOutput[] = [];
  if (platformSats > 0) {
    outputs.push({ address: taprootAddress, valueSats: platformSats });
  }
  if (affiliateSats > 0) {
    outputs.push({ address: affiliateAddress, valueSats: affiliateSats });
  }

  const sum = outputs.reduce((acc, o) => acc + o.valueSats, 0);
  if (sum !== total) {
    throw new Error(`Purchase outputs sum to ${sum} sats but total is ${total} sats`);
  }
  if (outputs.length === 0) {
    throw new Error('No payment outputs produced for top-level affiliate split');
  }
  return outputs;
}

/**
 * Computes revenue-split outputs without dust redistribution.
 * Returns a single taproot output when no tenant or affiliate split applies.
 */
export function computeRevenueSplitOutputs(input: PurchaseSplitInput): PurchasePaymentOutput[] {
  const total = assertPositiveInt('totalPriceSats', input.totalPriceSats);
  const taprootAddress = input.taprootAddress?.trim();
  if (!taprootAddress) {
    throw new Error('taprootAddress is required');
  }

  const tenantAddress = input.tenantPaymentAddress?.trim();
  const affiliateAddress = input.affiliatePaymentAddress?.trim();

  if (!tenantAddress) {
    if (!affiliateAddress) {
      return [{ address: taprootAddress, valueSats: total }];
    }
    return computeTopLevelAffiliateSplitOutputs(input);
  }

  const { platformSats, remaining } = resolvePlatformAndRemaining(input);

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

  return outputs;
}

function getOutputValue(outputs: PurchasePaymentOutput[], address: string): number {
  return outputs.find((output) => output.address === address)?.valueSats ?? 0;
}

function setOutputValue(
  outputs: PurchasePaymentOutput[],
  address: string,
  valueSats: number
): PurchasePaymentOutput[] {
  const next = outputs.filter((output) => output.address !== address);
  if (valueSats > 0) {
    next.push({ address, valueSats });
  }
  return next;
}

/**
 * Platform share at or below dust is paid to the tenant instead of taproot.
 */
function redistributeTaprootDustToTenant(
  outputs: PurchasePaymentOutput[],
  taprootAddress: string,
  tenantAddress: string
): { outputs: PurchasePaymentOutput[]; adjustments: string[] } {
  const adjustments: string[] = [];
  const merged = mergeOutputsByAddress(outputs);
  const taprootSats = getOutputValue(merged, taprootAddress);

  if (!isOutputBelowDust(taprootSats)) {
    return { outputs: merged, adjustments };
  }

  const tenantSats = getOutputValue(merged, tenantAddress) + taprootSats;
  adjustments.push(
    `Platform share ${taprootSats} sats (at or below dust ${PURCHASE_OUTPUT_MIN_SATS}) moved to tenant`
  );

  const withoutTaproot = merged.filter((output) => output.address !== taprootAddress);
  return {
    outputs: setOutputValue(withoutTaproot, tenantAddress, tenantSats),
    adjustments,
  };
}

/**
 * Affiliate/tenant dust shares are merged into whichever of those two had the larger amount.
 */
function redistributeAffiliateTenantDust(
  outputs: PurchasePaymentOutput[],
  affiliateAddress: string,
  tenantAddress: string
): { outputs: PurchasePaymentOutput[]; adjustments: string[] } {
  const adjustments: string[] = [];
  const merged = mergeOutputsByAddress(outputs);
  const affiliateSats = getOutputValue(merged, affiliateAddress);
  const tenantSats = getOutputValue(merged, tenantAddress);

  if (!affiliateSats && !tenantSats) {
    return { outputs: merged, adjustments };
  }

  const largerAddress =
    affiliateSats >= tenantSats ? affiliateAddress : tenantAddress;

  let dustPool = 0;
  let nextAffiliate = affiliateSats;
  let nextTenant = tenantSats;

  if (isOutputBelowDust(affiliateSats)) {
    dustPool += affiliateSats;
    nextAffiliate = 0;
  }
  if (isOutputBelowDust(tenantSats)) {
    dustPool += tenantSats;
    nextTenant = 0;
  }

  if (dustPool === 0) {
    return { outputs: merged, adjustments };
  }

  adjustments.push(
    `Affiliate/tenant dust (${dustPool} sats) merged into ${largerAddress === affiliateAddress ? 'affiliate' : 'tenant'} (larger share)`
  );

  if (largerAddress === affiliateAddress) {
    nextAffiliate += dustPool;
  } else {
    nextTenant += dustPool;
  }

  let next = merged.filter(
    (output) => output.address !== affiliateAddress && output.address !== tenantAddress
  );
  next = setOutputValue(next, affiliateAddress, nextAffiliate);
  next = setOutputValue(next, tenantAddress, nextTenant);

  return { outputs: mergeOutputsByAddress(next), adjustments };
}

/**
 * Affiliate/platform dust shares are merged into whichever of those two had the larger amount.
 */
function redistributeAffiliatePlatformDust(
  outputs: PurchasePaymentOutput[],
  affiliateAddress: string,
  taprootAddress: string
): { outputs: PurchasePaymentOutput[]; adjustments: string[] } {
  const adjustments: string[] = [];
  const merged = mergeOutputsByAddress(outputs);
  const affiliateSats = getOutputValue(merged, affiliateAddress);
  const platformSats = getOutputValue(merged, taprootAddress);

  if (!affiliateSats && !platformSats) {
    return { outputs: merged, adjustments };
  }

  const largerAddress = affiliateSats >= platformSats ? affiliateAddress : taprootAddress;

  let dustPool = 0;
  let nextAffiliate = affiliateSats;
  let nextPlatform = platformSats;

  if (isOutputBelowDust(affiliateSats)) {
    dustPool += affiliateSats;
    nextAffiliate = 0;
  }
  if (isOutputBelowDust(platformSats)) {
    dustPool += platformSats;
    nextPlatform = 0;
  }

  if (dustPool === 0) {
    return { outputs: merged, adjustments };
  }

  adjustments.push(
    `Affiliate/platform dust (${dustPool} sats) merged into ${largerAddress === affiliateAddress ? 'affiliate' : 'platform'} (larger share)`
  );

  if (largerAddress === affiliateAddress) {
    nextAffiliate += dustPool;
  } else {
    nextPlatform += dustPool;
  }

  let next = merged.filter(
    (output) => output.address !== affiliateAddress && output.address !== taprootAddress
  );
  next = setOutputValue(next, affiliateAddress, nextAffiliate);
  next = setOutputValue(next, taprootAddress, nextPlatform);

  return { outputs: mergeOutputsByAddress(next), adjustments };
}

/** Merge any remaining dust outputs into the largest output (last resort). */
function consolidateRemainingDust(
  outputs: PurchasePaymentOutput[]
): { outputs: PurchasePaymentOutput[]; adjustments: string[] } {
  const adjustments: string[] = [];
  let merged = mergeOutputsByAddress(outputs);

  while (merged.length > 1 && merged.some((output) => isOutputBelowDust(output.valueSats))) {
    const dustOutputs = merged.filter((output) => isOutputBelowDust(output.valueSats));
    const dustTotal = dustOutputs.reduce((sum, output) => sum + output.valueSats, 0);
    const survivors = merged.filter((output) => !isOutputBelowDust(output.valueSats));

    const target =
      survivors.length > 0
        ? survivors.reduce((largest, output) =>
            output.valueSats > largest.valueSats ? output : largest
          )
        : merged.reduce((largest, output) =>
            output.valueSats > largest.valueSats ? output : largest
          );

    adjustments.push(
      `Remaining dust (${dustTotal} sats) consolidated into largest output (${target.address})`
    );

    merged = mergeOutputsByAddress([
      ...merged.filter(
        (output) =>
          output.address !== target.address && !isOutputBelowDust(output.valueSats)
      ),
      { address: target.address, valueSats: target.valueSats + dustTotal },
    ]);
  }

  return { outputs: merged, adjustments };
}

function applyDustRedistribution(
  rawOutputs: PurchasePaymentOutput[],
  input: PurchaseSplitInput
): { outputs: PurchasePaymentOutput[]; adjustments: string[] } {
  const taprootAddress = input.taprootAddress.trim();
  const tenantAddress = input.tenantPaymentAddress?.trim();
  const affiliateAddress = input.affiliatePaymentAddress?.trim();

  if (!tenantAddress) {
    if (!affiliateAddress) {
      return { outputs: rawOutputs, adjustments: [] };
    }
    const adjustments: string[] = [];
    const affiliatePlatformStep = redistributeAffiliatePlatformDust(
      rawOutputs,
      affiliateAddress,
      taprootAddress
    );
    adjustments.push(...affiliatePlatformStep.adjustments);
    let outputs = affiliatePlatformStep.outputs;
    const consolidateStep = consolidateRemainingDust(outputs);
    adjustments.push(...consolidateStep.adjustments);
    outputs = consolidateStep.outputs;
    return { outputs, adjustments };
  }

  const adjustments: string[] = [];

  const taprootStep = redistributeTaprootDustToTenant(rawOutputs, taprootAddress, tenantAddress);
  adjustments.push(...taprootStep.adjustments);
  let outputs = taprootStep.outputs;

  if (affiliateAddress) {
    const affiliateStep = redistributeAffiliateTenantDust(
      outputs,
      affiliateAddress,
      tenantAddress
    );
    adjustments.push(...affiliateStep.adjustments);
    outputs = affiliateStep.outputs;
  }

  const consolidateStep = consolidateRemainingDust(outputs);
  adjustments.push(...consolidateStep.adjustments);
  outputs = consolidateStep.outputs;

  return { outputs, adjustments };
}

/**
 * Resolves purchase payment outputs from POST purchase response split fields.
 *
 * - No tenant, no affiliate: full total to taproot.
 * - Platform top-level + affiliate: affiliate % of discounted price; platform gets remainder + block_fee.
 * - With tenant: platform % of discounted price + block_fee to taproot; remainder to tenant and/or affiliate.
 * - Taproot dust → tenant (tenant spaces).
 * - Affiliate/tenant or affiliate/platform dust → merged into the larger share.
 */
export function resolvePurchasePaymentOutputs(
  input: PurchaseSplitInput
): PurchasePaymentOutputsResult {
  const total = assertPositiveInt('totalPriceSats', input.totalPriceSats);
  const taprootAddress = input.taprootAddress?.trim();
  if (!taprootAddress) {
    throw new Error('taprootAddress is required');
  }

  const tenantAddress = input.tenantPaymentAddress?.trim();
  const affiliateAddress = input.affiliatePaymentAddress?.trim();

  if (!tenantAddress && !affiliateAddress) {
    return {
      outputs: [assertOutputAboveDust({ address: taprootAddress, valueSats: total })],
      revenueSplitApplied: false,
    };
  }

  const attemptedSplitOutputs = computeRevenueSplitOutputs(input);
  const { outputs: redistributed, adjustments } = applyDustRedistribution(
    attemptedSplitOutputs,
    input
  );

  const sum = redistributed.reduce((acc, output) => acc + output.valueSats, 0);
  if (sum !== total) {
    throw new Error(`Purchase outputs sum to ${sum} sats but total is ${total} sats`);
  }

  const finalOutputs = redistributed.map(assertOutputAboveDust);
  const revenueSplitApplied = finalOutputs.length > 1;

  return {
    outputs: finalOutputs,
    revenueSplitApplied,
    ...(adjustments.length > 0
      ? { splitAdjustments: adjustments, attemptedSplitOutputs }
      : {}),
  };
}

/** @deprecated Prefer resolvePurchasePaymentOutputs for split metadata. */
export function computePurchasePaymentOutputs(input: PurchaseSplitInput): PurchasePaymentOutput[] {
  return resolvePurchasePaymentOutputs(input).outputs;
}

export function hasPurchaseRevenueSplit(input: PurchaseSplitInput): boolean {
  return Boolean(input.tenantPaymentAddress?.trim() || input.affiliatePaymentAddress?.trim());
}
