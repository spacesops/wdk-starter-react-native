#!/usr/bin/env node

/**
 * Extends deriveTaprootAddressesFromPaths to return Taproot key material per path.
 * Adds getTaprootKeyMaterialHex() on WalletAccountBtc (already in worklet graph)
 * and calls it from wdk-worklet.js — avoids new requires that break bare-pack.
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const workletPath = path.join(
  projectRoot,
  'node_modules',
  '@tetherto',
  'pear-wrk-wdk',
  'src',
  'wdk-worklet.js'
);
const providerWorkerBundlePath = path.join(
  projectRoot,
  'node_modules',
  '@tetherto',
  'wdk-react-native-provider',
  'lib',
  'module',
  'services',
  'wdk-service',
  'wdk-worklet.mobile.bundle.js'
);

const PATCH_MARKER = 'spaces-wallet-taproot-key-material';

const WALLET_METHOD = `
  /**
   * ${PATCH_MARKER}
   * Export Taproot internal pubkey + private + tweaked private key as hex.
   */
  getTaprootKeyMaterialHex () {
    if (this._scriptType !== 'P2TR' || !this._account || !this._internalPubkey) {
      return null
    }
    const internalPubkey = Buffer.from(this._internalPubkey)
    const privateKeyHex = Buffer.from(this._account.privateKey).toString('hex')
    const internalPubKeyHex = internalPubkey.toString('hex')
    const tapTweakHashValue = tapTweakHash(internalPubkey, undefined)
    const verifiedTweakedResult = tweakKey(internalPubkey, undefined)
    let internalPrivKey = Buffer.from(this._account.privateKey)
    const internalPubKeyFull = Buffer.from(this._account.publicKey)
    const secp256k1Order = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
    if ((internalPubKeyFull[0] & 1) === 1) {
      const internalPrivKeyBigInt = BigInt('0x' + internalPrivKey.toString('hex'))
      const negatedBigInt = (secp256k1Order - internalPrivKeyBigInt) % secp256k1Order
      internalPrivKey = Buffer.from(negatedBigInt.toString(16).padStart(64, '0'), 'hex')
    }
    const tweakedPrivKeyDirect = Buffer.from(ecc.privateAdd(internalPrivKey, tapTweakHashValue))
    let tweakedPrivKey
    if (verifiedTweakedResult.parity === 1) {
      const tweakedPrivKeyBigInt = BigInt('0x' + tweakedPrivKeyDirect.toString('hex'))
      const negatedBigInt = (secp256k1Order - tweakedPrivKeyBigInt) % secp256k1Order
      tweakedPrivKey = Buffer.from(negatedBigInt.toString(16).padStart(64, '0'), 'hex')
    } else {
      tweakedPrivKey = tweakedPrivKeyDirect
    }
    return {
      internalPubKeyHex,
      privateKeyHex,
      tweakedPrivateKeyHex: tweakedPrivKey.toString('hex'),
    }
  }
`;

const DERIVE_HANDLER_BASE = `rpc.onDeriveTaprootAddressesFromPaths(async payload => {
  try {
    const relativePaths = JSON.parse(payload.relativePathsJson)
    if (!Array.isArray(relativePaths)) {
      throw new Error('relativePathsJson must be a JSON array of path suffix strings')
    }
    const entries = []
    for (const rel of relativePaths) {
      if (typeof rel !== 'string') {
        throw new Error('Each relative path must be a string')
      }
      const account = await wdk.getAccountByPath('bitcoin', rel)
      const address = await account.getAddress()
      const scriptPubKeyHex = account.getScriptPubKeyHex(address)
      entries.push({ address, scriptPubKeyHex })
    }
    return { addressesJson: JSON.stringify(entries) }
  } catch (error) {
    throw new Error(rpcException.stringifyError(error))
  }
})`;

const DERIVE_HANDLER_NEW = `rpc.onDeriveTaprootAddressesFromPaths(async payload => {
  try {
    const relativePaths = JSON.parse(payload.relativePathsJson)
    if (!Array.isArray(relativePaths)) {
      throw new Error('relativePathsJson must be a JSON array of path suffix strings')
    }
    const entries = []
    for (const rel of relativePaths) {
      if (typeof rel !== 'string') {
        throw new Error('Each relative path must be a string')
      }
      const account = await wdk.getAccountByPath('bitcoin', rel)
      const address = await account.getAddress()
      const scriptPubKeyHex = account.getScriptPubKeyHex(address)
      const entry = { address, scriptPubKeyHex }
      if (typeof account.getTaprootKeyMaterialHex === 'function') {
        const keys = account.getTaprootKeyMaterialHex()
        if (keys) {
          entry.internalPubKeyHex = keys.internalPubKeyHex
          entry.privateKeyHex = keys.privateKeyHex
          entry.tweakedPrivateKeyHex = keys.tweakedPrivateKeyHex
        }
      }
      entries.push(entry)
    }
    return { addressesJson: JSON.stringify(entries) }
  } catch (error) {
    throw new Error(rpcException.stringifyError(error))
  }
})`;

function stripBrokenWorkletHelper (source) {
  const marker = `/** ${PATCH_MARKER} */`;
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) {
    return source;
  }
  const fnIdx = source.indexOf('function taprootKeyMaterialHex', markerIdx);
  if (fnIdx < 0) {
    return source;
  }
  let depth = 0;
  let end = fnIdx;
  for (let i = fnIdx; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  let out = source.slice(0, markerIdx) + source.slice(end);
  if (out[markerIdx] === '\n') {
    out = out.replace(/\n{2,}/, '\n');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function patchWorklet (source) {
  source = stripBrokenWorkletHelper(source);

  // Remove orphaned tail from a prior partial replace.
  source = source.replace(
    /\}\)\n    \}\n    return \{ addressesJson: JSON\.stringify\(entries\) \}\n  \} catch \(error\) \{\n    throw new Error\(rpcException\.stringifyError\(error\)\)\n  \}\n\}\)/,
    '})'
  );

  if (source.includes('getTaprootKeyMaterialHex')) {
    const deriveStart = source.indexOf('rpc.onDeriveTaprootAddressesFromPaths');
    const deriveEnd = source.indexOf('rpc.onDispose', deriveStart);
    const handler = source.slice(deriveStart, deriveEnd);
    if (!handler.includes('taprootKeyMaterialHex') && !handler.includes('    }\n    return { addressesJson')) {
      return { source, changed: false };
    }
  }

  const deriveStart = source.indexOf('rpc.onDeriveTaprootAddressesFromPaths');
  if (deriveStart < 0) {
    throw new Error('deriveTaprootAddressesFromPaths handler not found in wdk-worklet.js');
  }
  const deriveEnd = source.indexOf('\nrpc.onDispose', deriveStart);
  if (deriveEnd < 0) {
    throw new Error('Could not locate end of deriveTaprootAddressesFromPaths handler');
  }

  source = source.slice(0, deriveStart) + DERIVE_HANDLER_NEW + source.slice(deriveEnd);
  return { source, changed: true };
}

function resolveWalletBtcAccountPaths () {
  const seen = new Set();
  const paths = [];
  const add = (candidate) => {
    if (!candidate || !fs.existsSync(candidate)) return;
    const real = fs.realpathSync(candidate);
    if (seen.has(real)) return;
    seen.add(real);
    paths.push(real);
  };

  add(path.join(projectRoot, 'node_modules', '@wdk', 'wallet-btc', 'src', 'wallet-account-btc.js'));
  add(path.join(
    projectRoot,
    'node_modules',
    '@tetherto',
    'pear-wrk-wdk',
    'node_modules',
    '@wdk',
    'wallet-btc',
    'src',
    'wallet-account-btc.js'
  ));
  add(path.join(projectRoot, '..', 'wdk-wallet-btc', 'src', 'wallet-account-btc.js'));

  const pearPkgPath = path.join(projectRoot, 'node_modules', '@tetherto', 'pear-wrk-wdk', 'package.json');
  if (fs.existsSync(pearPkgPath)) {
    try {
      const dep = JSON.parse(fs.readFileSync(pearPkgPath, 'utf8')).dependencies?.['@wdk/wallet-btc'];
      if (typeof dep === 'string' && dep.startsWith('file:')) {
        const pearWrkDir = path.dirname(pearPkgPath);
        const resolved = path.resolve(pearWrkDir, dep.replace(/^file:/, ''));
        add(path.join(resolved, 'src', 'wallet-account-btc.js'));
      }
    } catch {
      /* ignore malformed package.json */
    }
  }

  return paths;
}

function patchWalletBtcFile (walletBtcPath) {
  let source = fs.readFileSync(walletBtcPath, 'utf8');
  if (source.includes(PATCH_MARKER)) {
    return false;
  }

  const anchor = `  get scriptType () {
    return this._scriptType
  }`;
  if (!source.includes(anchor)) {
    throw new Error(`wallet-account-btc scriptType getter anchor not found in ${walletBtcPath}`);
  }

  source = source.replace(anchor, `${anchor}${WALLET_METHOD}`);
  fs.writeFileSync(walletBtcPath, source);
  console.log(`Applied wallet-account-btc getTaprootKeyMaterialHex patch: ${walletBtcPath}`);
  return true;
}

function patchWalletBtc () {
  const targets = resolveWalletBtcAccountPaths();
  if (targets.length === 0) {
    console.log('@wdk/wallet-btc not found, skipping taproot key method patch');
    return false;
  }

  let changed = false;
  for (const target of targets) {
    if (patchWalletBtcFile(target)) {
      changed = true;
    }
  }
  if (!changed) {
    console.log('wallet-account-btc taproot key method already applied (all copies)');
  }
  return changed;
}

function invalidateWorkerBundleIfNeeded (changed) {
  if (!changed) return;
  if (fs.existsSync(providerWorkerBundlePath)) {
    fs.unlinkSync(providerWorkerBundlePath);
    console.log('Removed stale wdk-worklet.mobile.bundle.js — will regenerate on next build/postinstall');
  }
}

function main () {
  const walletPatched = patchWalletBtc();

  if (!fs.existsSync(workletPath)) {
    console.log('pear-wrk-wdk worklet not found, skipping worklet patch');
    return;
  }

  let source = fs.readFileSync(workletPath, 'utf8');
  const { source: next, changed: workletChanged } = patchWorklet(source);
  if (workletChanged) {
    fs.writeFileSync(workletPath, next);
    console.log('Applied pear-wrk-wdk deriveTaproot key material patch');
  } else {
    console.log('pear-wrk-wdk deriveTaproot key material patch already applied');
  }

  invalidateWorkerBundleIfNeeded(walletPatched || workletChanged);
}

main();
