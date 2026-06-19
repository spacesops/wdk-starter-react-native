/** Keys the server may embed in payment_watch.body — omit when registering txid (job already has spk). */
const SCRIPT_PUBKEY_BODY_KEYS = new Set([
  'script_pubkey',
  'scriptPubkey',
  'script_pub_key',
  'scriptPubKey',
  'script_pubkey_hex',
  'scriptPubKeyHex',
]);

const TX_ID_BODY_KEYS = new Set(['transaction_id', 'txid', 'tx_id', 'tx_hash', 'hash']);

/**
 * Builds the JSON body for watch-payment / pointer watch routes.
 * Keeps non-spk fields from the server template (e.g. handle) but always sets transaction_id.
 */
export function buildPaymentWatchRequestBody(
  specBody: Record<string, unknown> | undefined,
  transactionId: string,
  options?: { scriptPubKeyHex?: string }
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (specBody) {
    for (const [key, value] of Object.entries(specBody)) {
      if (SCRIPT_PUBKEY_BODY_KEYS.has(key) || TX_ID_BODY_KEYS.has(key)) {
        continue;
      }
      body[key] = value;
    }
  }

  body.transaction_id = transactionId;

  const spk = options?.scriptPubKeyHex?.trim();
  if (spk) {
    body.script_pubkey = spk;
  }

  return body;
}
