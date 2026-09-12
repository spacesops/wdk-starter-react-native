import getChainsConfig from '@/config/get-chains-config';
import { deriveBip86TaprootFromMnemonic } from '@/utils/derive-bip86-taproot';
import { getMnemonicWithoutWorklet } from '@/utils/mnemonic-from-secure-storage';
import { WDKSpaces } from '@/utils/wdk-spaces';
import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
  getSpacesAccountNumber,
  parseSpacesScanPathIndex,
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

function toKeyMaterial(params: {
  address: string;
  relativePath: string;
  derivationPath: string;
  scriptPubKeyHex?: string;
  internalPubKeyHex?: string;
  privateKeyHex?: string;
  tweakedPrivateKeyHex?: string;
}): TaprootKeyMaterial {
  return {
    address: params.address,
    priorAccountRelativePath: params.relativePath,
    derivationPath: params.derivationPath,
    scriptPubKeyHex: params.scriptPubKeyHex,
    internalPubKeyHex: params.internalPubKeyHex,
    privateKeyHex: params.privateKeyHex,
    tweakedPrivateKeyHex: params.tweakedPrivateKeyHex,
  };
}

async function derivePathWithWorklet(
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
  return toKeyMaterial({
    address: entry.address || encodedAddress || '',
    relativePath,
    derivationPath: fullPath,
    scriptPubKeyHex: entry.scriptPubKeyHex,
    internalPubKeyHex: entry.internalPubKeyHex,
    privateKeyHex: entry.privateKeyHex,
    tweakedPrivateKeyHex: entry.tweakedPrivateKeyHex,
  });
}

async function derivePathLocally(params: {
  mnemonic: string;
  storedPath?: string;
  targetSpk?: string;
}): Promise<TaprootKeyMaterial | null> {
  const { coinType } = getBitcoinTaprootPathPrefix();
  const account = getSpacesAccountNumber();
  const bitcoinNetwork = (getChainsConfig().bitcoin as { network?: string } | undefined)?.network;
  const target = params.targetSpk?.trim().toLowerCase();

  const tryIndex = (index: number) => {
    const derived = deriveBip86TaprootFromMnemonic({
      mnemonic: params.mnemonic,
      account,
      index,
      coinType,
      network: bitcoinNetwork,
    });
    if (target && derived.scriptPubKeyHex.toLowerCase() !== target) {
      return null;
    }
    return toKeyMaterial({
      address: derived.address,
      relativePath: derived.relativePath,
      derivationPath: derived.fullPath,
      scriptPubKeyHex: derived.scriptPubKeyHex,
      internalPubKeyHex: derived.internalPubKeyHex,
      privateKeyHex: derived.privateKeyHex,
      tweakedPrivateKeyHex: derived.tweakedPrivateKeyHex,
    });
  };

  const storedIndex = params.storedPath ? parseSpacesScanPathIndex(params.storedPath) : null;
  if (storedIndex !== null) {
    const fromStored = tryIndex(storedIndex);
    if (fromStored) {
      return fromStored;
    }
    console.warn(
      '[Spaces] local BIP-86 derive did not match script pubkey at stored path',
      params.storedPath
    );
  }

  const gap = buildSpacesScanDerivationPaths().length;
  for (let index = 0; index < gap; index++) {
    if (index === storedIndex) {
      continue;
    }
    const matched = tryIndex(index);
    if (matched) {
      return matched;
    }
  }

  return null;
}

export async function resolveTaprootForScriptPubKey(
  scriptPubKeyHex: string,
  options?: { derivationPath?: string; walletId?: string }
): Promise<TaprootKeyMaterial | null> {
  const bitcoinNetwork = (getChainsConfig().bitcoin as { network?: string } | undefined)?.network;
  const encodedAddress = scriptPubKeyHexToTaprootAddress(scriptPubKeyHex, bitcoinNetwork);
  const { bip, coinType } = getBitcoinTaprootPathPrefix();
  const target = scriptPubKeyHex.trim().toLowerCase();
  const storedPath = options?.derivationPath?.trim();

  try {
    const mnemonic = await getMnemonicWithoutWorklet(options?.walletId);
    if (mnemonic) {
      const local = await derivePathLocally({
        mnemonic,
        storedPath,
        targetSpk: target,
      });
      if (local) {
        return local;
      }
    }
  } catch (e) {
    console.warn('[Spaces] resolveTaprootForScriptPubKey local derive failed', e);
  }

  if (storedPath) {
    const rel = fullPathToWalletRelativePath(storedPath, bip, coinType);
    if (rel) {
      try {
        const derived = await derivePathWithWorklet(storedPath, rel);
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
      const derived = await derivePathWithWorklet(
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
      derivationPath: storedPath ?? '',
    };
  }
  return null;
}
