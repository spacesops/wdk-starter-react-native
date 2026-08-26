import getChainsConfig from '@/config/get-chains-config';
import { WDKSpaces } from '@/utils/wdk-spaces';
import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
} from '@/utils/spaces-scan-paths';
import { scriptPubKeyHexToTaprootAddress } from '@/utils/taproot-address-to-spk';

export type TaprootKeyMaterial = {
  address: string;
  priorAccountRelativePath: string;
  /** Full BIP-86 path, e.g. m/86'/0'/9'/0/0 */
  derivationPath: string;
  scriptPubKeyHex?: string;
  internalPubKeyHex?: string;
  privateKeyHex?: string;
  tweakedPrivateKeyHex?: string;
};

async function derivePathWithKeys(
  fullPath: string,
  relativePath: string
): Promise<TaprootKeyMaterial | null> {
  const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths([relativePath], {
    includeKeyMaterial: true,
  });
  const entries = JSON.parse(addressesJson) as {
    address?: string;
    scriptPubKeyHex?: string;
    internalPubKeyHex?: string;
    privateKeyHex?: string;
    tweakedPrivateKeyHex?: string;
  }[];
  const entry = entries[0];
  if (!entry?.address && !entry?.scriptPubKeyHex) {
    return null;
  }
  const bitcoinNetwork = (getChainsConfig().bitcoin as { network?: string } | undefined)?.network;
  const encodedAddress = entry.scriptPubKeyHex
    ? scriptPubKeyHexToTaprootAddress(entry.scriptPubKeyHex, bitcoinNetwork)
    : null;
  return {
    address: entry.address || encodedAddress || '',
    priorAccountRelativePath: relativePath,
    derivationPath: fullPath,
    scriptPubKeyHex: entry.scriptPubKeyHex,
    internalPubKeyHex: entry.internalPubKeyHex,
    privateKeyHex: entry.privateKeyHex,
    tweakedPrivateKeyHex: entry.tweakedPrivateKeyHex,
  };
}

export async function resolveTaprootForScriptPubKey(
  scriptPubKeyHex: string,
  options?: { derivationPath?: string }
): Promise<TaprootKeyMaterial | null> {
  const bitcoinNetwork = (getChainsConfig().bitcoin as { network?: string } | undefined)?.network;
  const encodedAddress = scriptPubKeyHexToTaprootAddress(scriptPubKeyHex, bitcoinNetwork);
  const { bip, coinType } = getBitcoinTaprootPathPrefix();
  const target = scriptPubKeyHex.trim().toLowerCase();

  const storedPath = options?.derivationPath?.trim();
  if (storedPath) {
    const rel = fullPathToWalletRelativePath(storedPath, bip, coinType);
    if (rel) {
      try {
        const derived = await derivePathWithKeys(storedPath, rel);
        if (derived) {
          return derived;
        }
      } catch (e) {
        console.warn('[Spaces] resolveTaprootForScriptPubKey stored path failed', storedPath, e);
      }
    }
  }

  const fullPaths = buildSpacesScanDerivationPaths();
  const rels: string[] = [];
  for (const p of fullPaths) {
    const rel = fullPathToWalletRelativePath(p, bip, coinType);
    if (rel) rels.push(rel);
  }

  for (let idx = 0; idx < rels.length; idx++) {
    const rel = rels[idx]!;
    try {
      const derived = await derivePathWithKeys(
        fullPaths[idx] ?? `m/${bip}'/${coinType}'/${rel}`,
        rel
      );
      if (!derived?.scriptPubKeyHex || derived.scriptPubKeyHex.trim().toLowerCase() !== target) {
        continue;
      }
      return derived;
    } catch (e) {
      console.warn('[Spaces] resolveTaprootForScriptPubKey path failed', rel, e);
    }
  }

  if (encodedAddress) {
    return {
      address: encodedAddress,
      priorAccountRelativePath: '',
      derivationPath: '',
    };
  }
  return null;
}
