import { base64ToUint8Array } from '@/utils/base64-bytes';
import {
  CERTRELAY_BASE_URL,
  fetchChainProofFromRelays,
  formatAnchorsJsonForLibveritas,
  getAnchorsJSON,
} from '@/utils/get-anchors-json';
import { formatSpacesVerifyError } from '@/utils/resolve-spaces-query';
import type { VerifiedZoneSummary } from '@/utils/extract-zone-attributes';

export type StoredCertificateFile = {
  root_cert: string;
  handle_cert: string;
};

export type CertificateVerificationMethod = 'stored-certificate' | 'certrelay';

export type ValidateStoredCertificateResult = {
  zones: VerifiedZoneSummary[];
  requestedHandle: string;
  requestedHandleFound: boolean;
  verificationMethod: CertificateVerificationMethod;
  /** Informational note when certrelay fallback was used after stored-cert assembly failed. */
  infoMessage?: string | null;
  warning?: string | null;
};

type LibveritasModule = typeof import('@spacesprotocol/react-native-libveritas');

/** libveritas expects byte views; plain ArrayBuffer slices break addCert/build on native. */
type LibveritasByteInput = ArrayBuffer | Uint8Array;

function parseStoredCertificateFile(certificate: unknown): StoredCertificateFile {
  if (!certificate || typeof certificate !== 'object') {
    throw new Error('Stored certificate payload is missing certificate data.');
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

/** Human-readable reason when stored cert + chain-proof assembly fails. */
export function formatCertificateAssemblyFailure(error: unknown): string {
  const msg = getErrorMessage(error);
  if (/missing root_cert|missing handle_cert|missing certificate/i.test(msg)) {
    return 'The saved certificate file is incomplete. Tap Receive Latest Certificate, then try again.';
  }
  if (/invalid cert|corrupt|unexpected length/i.test(msg)) {
    return 'The saved certificate file could not be read. Tap Receive Latest Certificate, then try again.';
  }
  if (/chain proof|\/chain-proof|no relays|network|abort|timed out|fetch/i.test(msg)) {
    return 'Could not fetch a chain proof from certrelay. Check your network connection and try again.';
  }
  if (/invalid chain proof|failed to fill whole buffer|not all bytes read/i.test(msg)) {
    return 'The saved certificate could not be combined with the chain proof from certrelay. Try receiving the latest certificate, then validate again.';
  }
  if (/receipt required/i.test(msg)) {
    return 'Certrelay does not yet have the proof needed to verify this handle from your saved certificate.';
  }
  if (/anchors unavailable/i.test(msg)) {
    return 'Trust anchors are unavailable. Check your network connection and try again.';
  }
  return `The saved certificate could not be verified locally (${msg}).`;
}

function buildQueryContext(
  lib: LibveritasModule,
  handle: string
): InstanceType<LibveritasModule['QueryContext']> {
  const ctx = new lib.QueryContext();
  const atIdx = handle.indexOf('@');
  const parentSpace = atIdx >= 0 ? handle.slice(atIdx) : handle;
  ctx.addRequest(handle);
  if (parentSpace !== handle) {
    ctx.addRequest(parentSpace);
  }
  return ctx;
}

async function verifyBuiltMessage(
  lib: LibveritasModule,
  veritas: InstanceType<LibveritasModule['Veritas']>,
  ctx: InstanceType<LibveritasModule['QueryContext']>,
  message: InstanceType<LibveritasModule['Message']>
): Promise<InstanceType<LibveritasModule['VerifiedMessage']>> {
  try {
    return veritas.verifyWithOptions(ctx, message, lib.verifyEnableSnark());
  } catch (snarkError) {
    console.warn('[Subspace] validateStoredCertificate: SNARK verify failed, retrying default', snarkError);
    return veritas.verify(ctx, message);
  }
}

/**
 * Build a libveritas Message from subsd cert.json using certrelay /chain-proof (primary path).
 */
async function assembleMessageFromStoredCertificate(
  lib: LibveritasModule,
  rootBytes: Uint8Array,
  handleBytes: Uint8Array
): Promise<InstanceType<LibveritasModule['Message']>> {
  const certOrders: LibveritasByteInput[][] = [
    [rootBytes, handleBytes],
    [handleBytes, rootBytes],
  ];

  let lastError: unknown = new Error('Certificate assembly failed.');
  for (const certs of certOrders) {
    try {
      const builder = new lib.MessageBuilder();
      for (const cert of certs) {
        builder.addCert(cert as unknown as ArrayBuffer);
      }
      const chainProofRequest = builder.chainProofRequest();
      const { data: chainProof } = await fetchChainProofFromRelays(chainProofRequest, [
        CERTRELAY_BASE_URL,
      ]);
      const proofBytes = new Uint8Array(chainProof);
      const built = builder.build(proofBytes as unknown as ArrayBuffer);
      console.log('[Subspace] validateStoredCertificate: assembled message from stored cert + certrelay chain proof');
      return built.message;
    } catch (error) {
      lastError = error;
      console.warn('[Subspace] validateStoredCertificate: assembly attempt failed', error);
    }
  }

  throw lastError;
}

function summarizeValidationResult(
  zones: VerifiedZoneSummary[],
  handleTrimmed: string
): Pick<ValidateStoredCertificateResult, 'zones' | 'requestedHandleFound' | 'warning'> {
  const requestedHandleFound = zones.some(
    (zone) => zone.handle.toLowerCase() === handleTrimmed.toLowerCase()
  );

  let warning: string | null = null;
  if (!requestedHandleFound) {
    warning =
      zones.length > 0
        ? `Verified parent chain only. ${handleTrimmed} is not present in the verified certificate data.`
        : `${handleTrimmed} was not found in verified certificate data.`;
  }

  return { zones, requestedHandleFound, warning };
}

async function verifyViaCertrelayQuery(
  handleTrimmed: string,
  anchorsJson: string,
  options: { noDns?: boolean }
): Promise<ValidateStoredCertificateResult> {
  const { resolveSpacesQuery } = await import('@/utils/resolve-spaces-query');
  const resolved = await resolveSpacesQuery(CERTRELAY_BASE_URL, anchorsJson, handleTrimmed, options);
  console.log(
    `[Subspace] validateStoredCertificate: certrelay query zones=${resolved.zones.map((z) => z.handle).join(', ')}`
  );

  return {
    zones: resolved.zones,
    requestedHandle: handleTrimmed,
    requestedHandleFound: resolved.requestedHandleFound,
    verificationMethod: 'certrelay',
    warning: resolved.warning ?? summarizeValidationResult(resolved.zones, handleTrimmed).warning,
  };
}

/**
 * Validate a downloaded subsd cert.json ({ root_cert, handle_cert }) with libveritas.
 * Primary: stored certs + certrelay chain proof. Secondary: certrelay handle query.
 */
export async function validateStoredCertificate(
  handle: string,
  certificate: unknown,
  options: { noDns?: boolean } = {}
): Promise<ValidateStoredCertificateResult> {
  const handleTrimmed = handle.trim();
  if (!handleTrimmed) {
    throw new Error('Handle is required for certificate validation.');
  }

  const { root_cert, handle_cert } = parseStoredCertificateFile(certificate);
  const rootBytes = base64ToUint8Array(root_cert);
  const handleBytes = base64ToUint8Array(handle_cert);

  const anchorsResult = await getAnchorsJSON({ noDns: options.noDns ?? false });
  if (!anchorsResult) {
    throw new Error('Trust anchors are unavailable. Check your network connection and try again.');
  }

  const [lib, { summarizeVerifiedZones, sortZonesForQuery }] = await Promise.all([
    import('@spacesprotocol/react-native-libveritas'),
    import('@/utils/extract-zone-attributes'),
  ]);

  const anchorsJson = formatAnchorsJsonForLibveritas(anchorsResult.anchors);
  const anchors = lib.Anchors.fromJson(anchorsJson);
  const veritas = new lib.Veritas(anchors);
  const ctx = buildQueryContext(lib, handleTrimmed);

  try {
    const message = await assembleMessageFromStoredCertificate(lib, rootBytes, handleBytes);
    const verified = await verifyBuiltMessage(lib, veritas, ctx, message);
    const zoneSummaries = await summarizeVerifiedZones(verified.zones());
    const zones = sortZonesForQuery(zoneSummaries, handleTrimmed);
    console.log(
      `[Subspace] validateStoredCertificate: verified from stored cert, zones=${zones.map((z) => z.handle).join(', ')}`
    );

    const result = summarizeValidationResult(zones, handleTrimmed);
    return {
      ...result,
      requestedHandle: handleTrimmed,
      verificationMethod: 'stored-certificate',
    };
  } catch (primaryError) {
    const assemblyReason = formatCertificateAssemblyFailure(primaryError);
    console.warn('[Subspace] validateStoredCertificate: primary assembly failed:', assemblyReason);

    try {
      const relayResult = await verifyViaCertrelayQuery(handleTrimmed, anchorsJson, options);
      return {
        ...relayResult,
        infoMessage: `${assemblyReason} Results below were verified through certrelay instead.`,
      };
    } catch (fallbackError) {
      const relayReason = formatSpacesVerifyError(fallbackError, handleTrimmed);
      throw new Error(`${assemblyReason} Certrelay fallback also failed: ${relayReason}`);
    }
  }
}
