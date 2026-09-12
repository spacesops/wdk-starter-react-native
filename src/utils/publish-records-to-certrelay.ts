import { base64ToUint8Array } from '@/utils/base64-bytes';
import {
  CERTRELAY_BASE_URL,
  fetchChainProofFromRelays,
  formatAnchorsJsonForLibveritas,
  getAnchorsJSON,
} from '@/utils/get-anchors-json';
import {
  formatHttpFailure,
  hexPreview,
  publishDebug,
  publishDebugWarn,
  summarizeWireRows,
} from '@/utils/publish-debug-log';
import { resolveTaprootForScriptPubKey } from '@/utils/resolve-taproot-for-script-pubkey';
import {
  bytesToHex,
  decodeRecordSet,
  encodePublishRecordSet,
  hexToBytes,
  splitInternalWireRows,
} from '@/lib/wire';
import ecc from '@bitcoinerlab/secp256k1';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_CHARS = 500;

type StoredCertificateFile = {
  root_cert: string;
  handle_cert: string;
};

type LibveritasModule = typeof import('@spacesprotocol/react-native-libveritas');

function parseStoredCertificate(certificate: unknown): StoredCertificateFile {
  if (!certificate || typeof certificate !== 'object') {
    throw new Error('Stored certificate is missing certificate data.');
  }
  const o = certificate as Record<string, unknown>;
  const rootCert = typeof o.root_cert === 'string' ? o.root_cert.trim() : '';
  const handleCert = typeof o.handle_cert === 'string' ? o.handle_cert.trim() : '';
  if (!rootCert || !handleCert) {
    throw new Error('Stored certificate is missing root_cert or handle_cert.');
  }
  return { root_cert: rootCert, handle_cert: handleCert };
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'inner' in error) {
    const inner = (error as { inner?: { msg?: string } }).inner;
    if (inner?.msg) {
      return inner.msg;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function signSpacesSchnorr(signingId: ArrayBuffer, tweakedPrivateKeyHex: string): Uint8Array {
  const privKey = hexToBytes(tweakedPrivateKeyHex.trim());
  if (privKey.length !== 32) {
    throw new Error('Taproot signing key is unavailable for this script pubkey.');
  }
  const hash = new Uint8Array(signingId);
  if (hash.length !== 32) {
    throw new Error('Invalid signing hash from libveritas.');
  }
  return ecc.signSchnorr(hash, privKey);
}

async function logLocalVerifyPreflight(
  lib: LibveritasModule,
  handle: string,
  message: InstanceType<LibveritasModule['Message']>
): Promise<void> {
  try {
    const anchorsResult = await getAnchorsJSON();
    const anchorsJson = formatAnchorsJsonForLibveritas(anchorsResult.anchors);
    const anchors = lib.Anchors.fromJson(anchorsJson);
    const veritas = new lib.Veritas(anchors);
    const ctx = new lib.QueryContext();
    ctx.addRequest(handle);
    const atIdx = handle.indexOf('@');
    const parentSpace = atIdx >= 0 ? handle.slice(atIdx) : handle;
    if (parentSpace !== handle) {
      ctx.addRequest(parentSpace);
    }

    try {
      veritas.verifyWithOptions(ctx, message, lib.verifyEnableSnark());
      publishDebug('local verify preflight ok (snark)');
    } catch (snarkError) {
      publishDebugWarn('local verify preflight snark failed, retrying default', getErrorMessage(snarkError));
      veritas.verify(ctx, message);
      publishDebug('local verify preflight ok (default)');
    }
  } catch (error) {
    publishDebugWarn('local verify preflight failed', getErrorMessage(error));
  }
}

async function broadcastMessageToRelays(
  messageBytes: Uint8Array,
  relayUrls: string[]
): Promise<{ peerUrl: string }> {
  const urls = relayUrls.filter(Boolean);
  if (urls.length === 0) {
    throw new Error('No certrelay URLs configured.');
  }

  publishDebug('POST /message', {
    relayCount: urls.length,
    messageBytes: messageBytes.length,
    messageHexPreview: hexPreview(messageBytes, 64),
  });

  let lastError = 'Publish failed on all certrelay peers.';
  for (const peerUrl of urls) {
    const url = `${peerUrl.replace(/\/$/, '')}/message`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      publishDebug('POST /message attempt', { url, bytes: messageBytes.length });
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
        },
        body: messageBytes as unknown as BodyInit,
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = formatHttpFailure('POST /message', peerUrl, response.status, text, MAX_ERROR_BODY_CHARS);
        publishDebugWarn('POST /message rejected', {
          url,
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: text.trim() || '(empty response body)',
        });
        continue;
      }
      publishDebug('POST /message ok', { peerUrl, status: response.status });
      return { peerUrl };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      publishDebugWarn('POST /message network error', { url, error: lastError });
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(lastError);
}

export type PublishRecordsToCertrelayParams = {
  handle: string;
  recordsWireHex: string;
  certificate: unknown;
  scriptPubKeyHex: string;
  derivationPath?: string;
  walletId?: string;
  relayUrls?: string[];
};

/**
 * Build, sign, and POST a Spaces message to certrelay (/message).
 * Follows libveritas MessageBuilder + Schnorr signing (fabric.publish flow).
 */
export async function publishRecordsToCertrelay(
  params: PublishRecordsToCertrelayParams
): Promise<{ peerUrl: string }> {
  const handleTrimmed = params.handle.trim();
  if (!handleTrimmed) {
    throw new Error('Handle is required to publish records.');
  }

  const wireHex = params.recordsWireHex.trim();
  if (wireHex.length > 0 && wireHex.length % 2 !== 0) {
    throw new Error('Wire hex must have an even number of digits.');
  }

  publishDebug('start', {
    handle: handleTrimmed,
    wireHexChars: wireHex.length,
    scriptPubKeyPrefix: params.scriptPubKeyHex.trim().slice(0, 16),
    relayUrls: params.relayUrls ?? [CERTRELAY_BASE_URL],
  });

  let recordsWireBytes = new Uint8Array(0);
  const lib = await import('@spacesprotocol/react-native-libveritas');
  if (wireHex.length > 0) {
    const decoded = decodeRecordSet(hexToBytes(wireHex.toUpperCase()));
    const { seqVersion, visibleRows } = splitInternalWireRows(decoded);
    recordsWireBytes = encodePublishRecordSet(visibleRows, seqVersion);
    publishDebug('wire prepared', {
      currentSeq: seqVersion,
      publishSeq: seqVersion + 1,
      attributeRecords: visibleRows.length,
      rows: summarizeWireRows(visibleRows),
      editableWireHex: wireHex.slice(0, 120),
      publishWireBytes: recordsWireBytes.length,
      publishWireHex: bytesToHex(recordsWireBytes),
    });
  }

  const taproot = await resolveTaprootForScriptPubKey(params.scriptPubKeyHex, {
    derivationPath: params.derivationPath,
    walletId: params.walletId,
  });
  if (!taproot?.tweakedPrivateKeyHex) {
    throw new Error('Script pubkey does not match any configured Spaces scan path.');
  }
  publishDebug('signing key resolved', {
    derivationPath: taproot.derivationPath,
    taprootAddress: taproot.address,
    internalPubKeyPrefix: taproot.internalPubKeyHex?.slice(0, 16) ?? '(unknown)',
  });

  const { root_cert, handle_cert } = parseStoredCertificate(params.certificate);
  const rootBytes = base64ToUint8Array(root_cert);
  const handleBytes = base64ToUint8Array(handle_cert);
  publishDebug('stored certificate', {
    rootCertBytes: rootBytes.length,
    handleCertBytes: handleBytes.length,
  });

  const relayUrls = params.relayUrls ?? [CERTRELAY_BASE_URL];

  const certOrders: Uint8Array[][] = [
    [rootBytes, handleBytes],
    [handleBytes, rootBytes],
  ];

  let lastError: unknown = new Error('Could not build publish message.');
  for (let orderIndex = 0; orderIndex < certOrders.length; orderIndex++) {
    const certs = certOrders[orderIndex]!;
    publishDebug('assembly attempt', { orderIndex: orderIndex + 1, certCount: certs.length });
    try {
      const builder = new lib.MessageBuilder();
      for (const cert of certs) {
        builder.addCert(cert as unknown as ArrayBuffer);
      }
      builder.addUpdate(
        lib.DataUpdateEntry.create({
          name: handleTrimmed,
          records: recordsWireBytes as unknown as ArrayBuffer,
          delegateRecords: undefined,
        })
      );

      const chainProofRequest = builder.chainProofRequest();
      publishDebug('chain-proof request', {
        orderIndex: orderIndex + 1,
        requestType: typeof chainProofRequest,
        requestJson: (
          typeof chainProofRequest === 'string'
            ? chainProofRequest
            : JSON.stringify(chainProofRequest)
        ).slice(0, 800),
      });

      let chainProof: ArrayBuffer;
      let chainProofPeer: string;
      try {
        const chainProofResult = await fetchChainProofFromRelays(chainProofRequest, relayUrls);
        chainProof = chainProofResult.data;
        chainProofPeer = chainProofResult.peerUrl;
        publishDebug('chain-proof ok', {
          peerUrl: chainProofPeer,
          proofBytes: chainProof.byteLength,
          proofHexPreview: hexPreview(new Uint8Array(chainProof), 32),
        });
      } catch (error) {
        publishDebugWarn('chain-proof failed', {
          orderIndex: orderIndex + 1,
          error: getErrorMessage(error),
        });
        throw error;
      }

      let built: ReturnType<LibveritasModule['MessageBuilder']['prototype']['build']>;
      try {
        built = builder.build(new Uint8Array(chainProof) as unknown as ArrayBuffer);
      } catch (error) {
        publishDebugWarn('MessageBuilder.build failed', {
          orderIndex: orderIndex + 1,
          error: getErrorMessage(error),
        });
        throw error;
      }

      const message = built.message;
      publishDebug('message built', {
        orderIndex: orderIndex + 1,
        unsignedCount: built.unsigned.length,
      });

      if (built.unsigned.length === 0) {
        throw new Error(
          'Publish message has no unsigned record sets to sign. Do not include a SIG record in the update payload.'
        );
      }

      for (let i = 0; i < built.unsigned.length; i++) {
        const unsigned = built.unsigned[i]!;
        unsigned.setFlags(unsigned.flags() | lib.sigPrimaryZone());
        const signingId = new Uint8Array(unsigned.signingId());
        const signature = signSpacesSchnorr(unsigned.signingId(), taproot.tweakedPrivateKeyHex);
        const signedRecords = unsigned.packSig(signature as unknown as ArrayBuffer);
        message.setRecords(unsigned.canonical(), signedRecords);
        publishDebug('record set signed', {
          index: i + 1,
          canonical: unsigned.canonical(),
          flags: unsigned.flags(),
          signingIdHex: bytesToHex(signingId),
          signatureHex: bytesToHex(signature),
          signedRecordsBytes: new Uint8Array(signedRecords).length,
          signedRecordsHexPreview: hexPreview(new Uint8Array(signedRecords), 48),
        });
      }

      const messageBytes = new Uint8Array(message.toBytes());
      publishDebug('message ready', {
        orderIndex: orderIndex + 1,
        messageBytes: messageBytes.length,
        messageHexPreview: hexPreview(messageBytes, 64),
      });

      await logLocalVerifyPreflight(lib, handleTrimmed, message);

      const result = await broadcastMessageToRelays(messageBytes, relayUrls);
      publishDebug('publish ok', { peerUrl: result.peerUrl, orderIndex: orderIndex + 1 });
      return result;
    } catch (error) {
      lastError = error;
      publishDebugWarn('assembly attempt failed', {
        orderIndex: orderIndex + 1,
        error: getErrorMessage(error),
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
