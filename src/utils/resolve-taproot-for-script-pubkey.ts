import { WDKSpaces } from '@/utils/wdk-spaces';
import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
} from '@/utils/spaces-scan-paths';

export type TaprootKeyMaterial = {
  address: string;
  priorAccountRelativePath: string;
  /** Full BIP-86 path, e.g. m/86'/0'/9'/0/0 */
  derivationPath: string;
  internalPubKeyHex?: string;
  privateKeyHex?: string;
  tweakedPrivateKeyHex?: string;
};

export async function resolveTaprootForScriptPubKey(
  scriptPubKeyHex: string
): Promise<TaprootKeyMaterial | null> {
  const { bip, coinType } = getBitcoinTaprootPathPrefix();
  const fullPaths = buildSpacesScanDerivationPaths();
  const rels: string[] = [];
  for (const p of fullPaths) {
    const rel = fullPathToWalletRelativePath(p, bip, coinType);
    if (rel) rels.push(rel);
  }
  if (rels.length === 0) return null;
  const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths(rels);
  const entries = JSON.parse(addressesJson) as {
    address?: string;
    scriptPubKeyHex?: string;
    internalPubKeyHex?: string;
    privateKeyHex?: string;
    tweakedPrivateKeyHex?: string;
  }[];
  const target = scriptPubKeyHex.toLowerCase();
  const idx = entries.findIndex((e) => e.scriptPubKeyHex?.toLowerCase() === target);
  if (idx < 0 || !entries[idx]?.address) return null;
  const derivationPath = fullPaths[idx] ?? `m/${bip}'/${coinType}'/${rels[idx]}`;
  const entry = entries[idx];
  return {
    address: entry.address!,
    priorAccountRelativePath: rels[idx],
    derivationPath,
    internalPubKeyHex: entry.internalPubKeyHex,
    privateKeyHex: entry.privateKeyHex,
    tweakedPrivateKeyHex: entry.tweakedPrivateKeyHex,
  };
}
