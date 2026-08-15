/**
 * New core addresses are nested: Record<network, Record<accountIndex, string>>.
 * Most Spaces screens still expect a flat Record<network, string> (account 0).
 */

export type NestedWalletAddresses = Record<string, Record<number, string> | string | undefined>;

/** Flatten nested addresses to network → primary (index 0) address. */
export function flattenWalletAddresses(
  addresses: NestedWalletAddresses | null | undefined
): Record<string, string> {
  if (!addresses) {
    return {};
  }

  const flat: Record<string, string> = {};
  for (const [network, value] of Object.entries(addresses)) {
    if (typeof value === 'string' && value) {
      flat[network] = value;
      continue;
    }
    if (value && typeof value === 'object') {
      const primary =
        (value as Record<number | string, string>)[0] ??
        (value as Record<number | string, string>)['0'] ??
        Object.values(value).find(v => typeof v === 'string' && v);
      if (typeof primary === 'string' && primary) {
        flat[network] = primary;
      }
    }
  }
  return flat;
}

/** Primary address for a network (account index 0). */
export function getWalletAddress(
  addresses: NestedWalletAddresses | null | undefined,
  network: string
): string | undefined {
  if (!addresses) {
    return undefined;
  }
  const value = addresses[network];
  if (typeof value === 'string') {
    return value || undefined;
  }
  if (value && typeof value === 'object') {
    return (
      value[0] ??
      (value as Record<string, string>)['0'] ??
      Object.values(value).find(v => typeof v === 'string' && v)
    );
  }
  return undefined;
}
