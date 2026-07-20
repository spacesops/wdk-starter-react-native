#!/usr/bin/env node

/**
 * Ensures @wdk/wallet-btc memo coin selection accounts for OP_RETURN fees.
 * Idempotent — safe to run on every postinstall.
 */

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'addUntilReach+opReturnValidation';

const IMPORT_OLD = "import { coinselect } from '@bitcoinerlab/coinselect'";
const IMPORT_NEW =
  "import { addUntilReach, coinselect } from '@bitcoinerlab/coinselect'";

const BLOCK_OLD = `    const coinselectInput = {
      utxos: utxosForCoinSelect,
      remainder: fromAddressOutput,
      targets: [{ output: toAddressOutput, value: Number(amount) }],
      feeRate: Number(feeRate)
    }

    console.log('[_planSpendWithMemo] coinselect input:', JSON.stringify({
      utxoCount: utxosForCoinSelect.length,
      utxoValues: utxosForCoinSelect.map(u => u.value),
      utxoTotalSats: utxosForCoinSelect.reduce((s, u) => s + u.value, 0),
      targetValue: Number(amount),
      feeRate: Number(feeRate),
      fromDescriptor: fromAddressOutput.toString(),
      toDescriptor: toAddressOutput.toString()
    }))

    const result = coinselect(coinselectInput)

    if (!result) {
      console.error('[_planSpendWithMemo] coinselect returned null — insufficient balance', JSON.stringify({
        utxoTotalSats: utxosForCoinSelect.reduce((s, u) => s + u.value, 0),
        targetSats: Number(amount),
        feeRate: Number(feeRate),
        utxoCount: utxosForCoinSelect.length,
        utxoValues: utxosForCoinSelect.map(u => u.value),
        opReturnSize: opReturnOutputSize,
        memoLength: memoBuffer.length
      }))
      throw new Error('🚀🚀🚀 LOCAL PACKAGE ACTIVE - Insufficient balance to send the transaction. 🚀🚀🚀')
    }

    if (result.utxos.length > MAX_UTXO_INPUTS) {
      throw new Error('Exceeded maximum allowed inputs for transaction.')
    }

    // Add additional fee for OP_RETURN output
    // OP_RETURN outputs add to the transaction size, so we need to account for this
    const baseFee = this._toBigInt(Math.max(result.fee ?? 0, MIN_TX_FEE_SATS))
    const opReturnFee = this._toBigInt(opReturnOutputSize) * feeRate
    const totalFee = baseFee + opReturnFee

    const utxos = result.utxos.map(({ __ref }) => ({
      ...__ref,
      vout: {
        value: this._toBigInt(__ref.value),
        scriptPubKey: { hex: fromAddressScriptHex }
      }
    }))

    const total = utxos.reduce((s, u) => s + this._toBigInt(u.value), 0n)
    const changeValue = total - totalFee - amount

    if (changeValue < 0n) {
      throw new Error('Insufficient balance after fees (including OP_RETURN output).')
    }

    if (changeValue <= this._dustLimit) {
      return {
        utxos,
        fee: totalFee + changeValue,
        changeValue: 0n
      }
    }

    return { utxos, fee: totalFee, changeValue }`;

const BLOCK_NEW = `    const coinselectInputBase = {
      remainder: fromAddressOutput,
      targets: [{ output: toAddressOutput, value: Number(amount) }],
      feeRate: Number(feeRate)
    }

    console.log('[_planSpendWithMemo] coinselect input:', JSON.stringify({
      utxoCount: utxosForCoinSelect.length,
      utxoValues: utxosForCoinSelect.map(u => u.value),
      utxoTotalSats: utxosForCoinSelect.reduce((s, u) => s + u.value, 0),
      targetValue: Number(amount),
      feeRate: Number(feeRate),
      opReturnSize: opReturnOutputSize,
      memoLength: memoBuffer.length,
      selectionStrategy: '${PATCH_MARKER}'
    }))

    // coinselect() runs avoidChange first, which often picks one UTXO that covers payment
    // plus base tx fee but not the OP_RETURN output fee added below. addUntilReach allows
    // change outputs and can combine inputs when a single UTXO is too small after memo fees.
    let pool = [...utxosForCoinSelect]
    let selected = null
    let totalFee = 0n
    let changeValue = 0n

    while (pool.length > 0 && !selected) {
      const result = addUntilReach({ ...coinselectInputBase, utxos: pool })
      if (!result) {
        break
      }

      const baseFee = this._toBigInt(Math.max(result.fee ?? 0, MIN_TX_FEE_SATS))
      const opReturnFee = this._toBigInt(opReturnOutputSize) * feeRate
      const candidateTotalFee = baseFee + opReturnFee
      const candidateTotal = result.utxos.reduce((s, u) => s + this._toBigInt(u.value), 0n)
      const candidateChange = candidateTotal - candidateTotalFee - amount

      if (candidateChange >= 0n) {
        selected = result
        if (candidateChange <= this._dustLimit) {
          totalFee = candidateTotalFee + candidateChange
          changeValue = 0n
        } else {
          totalFee = candidateTotalFee
          changeValue = candidateChange
        }
        console.log('[_planSpendWithMemo] selected inputs:', {
          utxoValues: result.utxos.map(u => u.value),
          inputCount: result.utxos.length,
          baseFee: baseFee.toString(),
          opReturnFee: opReturnFee.toString(),
          totalFee: totalFee.toString(),
          changeValue: changeValue.toString()
        })
        break
      }

      console.warn('[_planSpendWithMemo] selection insufficient after OP_RETURN fee; retrying with larger inputs', {
        picked: result.utxos.map(u => u.value),
        candidateChange: candidateChange.toString(),
        opReturnFee: opReturnFee.toString()
      })

      const minSelected = Math.min(...result.utxos.map(u => u.value))
      const nextPool = pool.filter(u => u.value > minSelected)
      if (nextPool.length === pool.length) {
        break
      }
      pool = nextPool
    }

    if (!selected) {
      console.error('[_planSpendWithMemo] coinselect returned null — insufficient balance', JSON.stringify({
        utxoTotalSats: utxosForCoinSelect.reduce((s, u) => s + u.value, 0),
        targetSats: Number(amount),
        feeRate: Number(feeRate),
        utxoCount: utxosForCoinSelect.length,
        utxoValues: utxosForCoinSelect.map(u => u.value),
        opReturnSize: opReturnOutputSize,
        memoLength: memoBuffer.length
      }))
      throw new Error('🚀🚀🚀 LOCAL PACKAGE ACTIVE - Insufficient balance to send the transaction. 🚀🚀🚀')
    }

    if (selected.utxos.length > MAX_UTXO_INPUTS) {
      throw new Error('Exceeded maximum allowed inputs for transaction.')
    }

    const utxos = selected.utxos.map(({ __ref }) => ({
      ...__ref,
      vout: {
        value: this._toBigInt(__ref.value),
        scriptPubKey: { hex: fromAddressScriptHex }
      }
    }))

    return { utxos, fee: totalFee, changeValue }`;

function patchFile(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return 'missing';
  }

  let content = fs.readFileSync(targetPath, 'utf8');
  if (content.includes(PATCH_MARKER)) {
    return 'already';
  }

  if (!content.includes(BLOCK_OLD)) {
    console.warn(
      `[patch-wdk-wallet-btc-memo-coinselect] Unexpected file contents in ${targetPath}; skipping.`
    );
    return 'skipped';
  }

  if (!content.includes(IMPORT_OLD)) {
    console.warn(
      `[patch-wdk-wallet-btc-memo-coinselect] Import block not found in ${targetPath}; skipping.`
    );
    return 'skipped';
  }

  content = content.replace(IMPORT_OLD, IMPORT_NEW);
  content = content.replace(BLOCK_OLD, BLOCK_NEW);
  fs.writeFileSync(targetPath, content, 'utf8');
  return 'patched';
}

const projectRoot = path.join(__dirname, '..');
const targets = [
  path.join(projectRoot, 'node_modules', '@wdk', 'wallet-btc', 'src', 'wallet-account-read-only-btc.js'),
  path.join(projectRoot, '..', 'wdk-wallet-btc', 'src', 'wallet-account-read-only-btc.js'),
];

let patchedAny = false;
for (const targetPath of targets) {
  const result = patchFile(targetPath);
  if (result === 'patched') {
    patchedAny = true;
    console.log(`[patch-wdk-wallet-btc-memo-coinselect] Patched ${targetPath}`);
  }
}

if (!patchedAny) {
  console.log('[patch-wdk-wallet-btc-memo-coinselect] Already patched or no targets updated.');
}
