import getChainsConfig from '@/config/get-chains-config';

/**
 * Coin type segment for BIP-86 paths (m/86'/{coin}'/…).
 * Matches comments in get-chains-config: mainnet 0, testnet 1.
 */
function bitcoinCoinTypeSegment(network: string | undefined): number {
  const n = (network ?? 'bitcoin').toLowerCase();
  if (n === 'testnet' || n === 'regtest') return 1;
  return 0;
}

/** BIP number and coin-type segment as used in full paths and WalletManagerBtc. */
export function getBitcoinTaprootPathPrefix(): { bip: number; coinType: number } {
  const chains = getChainsConfig();
  const bitcoin = chains.bitcoin as { bip?: number; network?: string } | undefined;
  const bip = typeof bitcoin?.bip === 'number' ? bitcoin.bip : 86;
  const coinType = bitcoinCoinTypeSegment(bitcoin?.network);
  return { bip, coinType };
}

/** Hardened account index for Spaces handles (`m/86'/0'/{account}'/0/x`). */
export function getSpacesAccountNumber(): number {
  const accountRaw =
    process.env.EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER ?? process.env.SPACES_ACCOUNT_NUMBER ?? '0';
  const account = Number.parseInt(String(accountRaw), 10);
  return Number.isFinite(account) && account >= 0 ? account : 0;
}

/**
 * Address index `x` when `fullPath` is a Spaces scan path
 * `m/{bip}'/{coin}'/{account}'/0/x` (account from EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER).
 */
export function parseSpacesScanPathIndex(fullPath: string): number | null {
  const { bip, coinType } = getBitcoinTaprootPathPrefix();
  const account = getSpacesAccountNumber();
  const match = fullPath
    .trim()
    .match(new RegExp(`^m/${bip}'/${coinType}'/${account}'/0/(\\d+)$`));
  if (!match) {
    return null;
  }
  const idx = Number.parseInt(match[1]!, 10);
  return Number.isFinite(idx) && idx >= 0 ? idx : null;
}

/**
 * Strips m/{bip}'/{coin}'/ from a full path → suffix passed to getAccountByPath (e.g. 9'/0/0).
 */
export function fullPathToWalletRelativePath(
  fullPath: string,
  bip: number,
  coinType: number
): string | null {
  const prefix = `m/${bip}'/${coinType}'/`;
  if (!fullPath.startsWith(prefix)) return null;
  return fullPath.slice(prefix.length);
}

/**
 * Builds Taproot scan paths: m/{bip}'/{coin}'/{account}'/0/{0..gap-1}
 * using bitcoin config from get-chains-config and env:
 * EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER (account index, hardened),
 * EXPO_PUBLIC_SPACES_ACCOUNT_GAP (count of address indices).
 */
export function buildSpacesScanDerivationPaths(): string[] {
  const { bip, coinType } = getBitcoinTaprootPathPrefix();
  const account = getSpacesAccountNumber();

  const gapRaw =
    process.env.EXPO_PUBLIC_SPACES_ACCOUNT_GAP ?? process.env.SPACES_ACCOUNT_GAP ?? '1';
  const gap = Number.parseInt(String(gapRaw), 10);

  if (!Number.isFinite(account) || account < 0 || !Number.isFinite(gap) || gap < 1) {
    console.warn(
      '[Spaces] buildSpacesScanDerivationPaths: invalid SPACES_ACCOUNT_NUMBER or SPACES_ACCOUNT_GAP (use EXPO_PUBLIC_* in app)'
    );
    return [];
  }

  const paths: string[] = [];
  for (let i = 0; i < gap; i++) {
    paths.push(`m/${bip}'/${coinType}'/${account}'/0/${i}`);
  }
  return paths;
}
