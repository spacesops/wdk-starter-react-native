import Header from '@/components/header';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { AtSign, Check, ChevronDown, ChevronRight, ChevronUp, Circle, Copy, Info, Search } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/colors';
import { pricingService, FiatCurrency, getPricingServiceHostname } from '@/services/pricing-service';
import {
  AssetTicker,
  NetworkType,
  useWallet,
  WDKService,
} from '@tetherto/wdk-react-native-provider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import getChainsConfig from '@/config/get-chains-config';
import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
} from '@/utils/spaces-scan-paths';
import { buildPaymentWatchRequestBody } from '@/utils/build-payment-watch-body';
import { formatMySpaceHandleStatusLabel } from '@/utils/format-my-space-status';
import { resolveNextAvailableTaprootPath } from '@/utils/resolve-next-spaces-path';
import { WDKSpaces } from '@/utils/wdk-spaces';
import { registerPurchaseStatusPollStarter } from '@/utils/purchase-poll-bridge';
import {
  formatAnchorsJsonForLibveritas,
  getAnchorsJSON,
  type AnchorsResponse,
} from '@/utils/get-anchors-json';
import {
  formatZoneAttributeLabel,
  formatZoneAttributeValue,
  orderZoneAttributes,
  type VerifiedZoneSummary,
} from '@/utils/extract-zone-attributes';
import { resolveTaprootPurchaseRequiredSats } from '@/utils/estimate-taproot-memo-fee';
import * as Clipboard from 'expo-clipboard';
import { toast } from 'sonner-native';

const SPACE_NAME_OPTIONS = ['spacesops_services', 'are_currently_unavailable', 'try_again_later'];
const DURATION_OPTIONS = ['~10 mins', '~1 hour', '~8 hours'];
const SPACES_API_BASE_URL = process.env.EXPO_PUBLIC_SPACES_API_BASE_URL || 'http://192.168.1.111:7264';
const SPACES_APP_NAME = 'spaces-wallet';
const EMPTY_SUBSPACE_BUTTON_LABEL = 'Enter a subspace name';
const NO_SPACE_NAME_BUTTON_LABEL = 'Select a Space name';

function idlePurchaseButtonLabel(subspaceValue: string, spaceNameValue: string): string {
  if (subspaceValue.trim().length === 0) {
    return EMPTY_SUBSPACE_BUTTON_LABEL;
  }
  if (!spaceNameValue.trim()) {
    return NO_SPACE_NAME_BUTTON_LABEL;
  }
  return 'Purchase';
}

/** @see PURCHASE.md — subname quote + purchase; pointer flow is separate (`purchase_type: "pointer"`). */
const PURCHASE_TYPE_SUBNAME = 'subname';
const PURCHASE_TYPE_POINTER = 'pointer';

/** Dedupe concurrent `pollJobStatus` for the same job (e.g. Subspace + My Spaces). */
const activePurchaseJobPolls = new Set<number>();

/**
 * GET /api/purchases/:spaceName/:subspace/status — `unified_status` for one handle.
 * `purchaseType` `pointer` = Take on-chain row; else subname.
 * HTTP **404** = no purchase row for this handle (e.g. discovered via Find Spaces only) — not an error.
 */
async function fetchUnifiedHandleStatus(
  baseUrl: string,
  spaceName: string,
  subspace: string,
  purchaseType: 'subname' | 'pointer' | undefined
): Promise<{ unifiedStatus: string | null; noServerPurchase: boolean }> {
  const pt = purchaseType === 'pointer' ? PURCHASE_TYPE_POINTER : PURCHASE_TYPE_SUBNAME;
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/api/purchases/${encodeURIComponent(spaceName)}/${encodeURIComponent(subspace)}/status?purchase_type=${pt}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 404) {
      return { unifiedStatus: null, noServerPurchase: true };
    }
    const data = (await res.json()) as { success?: boolean; unified_status?: string };
    if (res.ok && data.success && typeof data.unified_status === 'string') {
      return { unifiedStatus: data.unified_status, noServerPurchase: false };
    }
    console.warn('[Spaces] fetchUnifiedHandleStatus', { spaceName, subspace, pt, status: res.status });
  } catch (e) {
    console.warn('[Spaces] fetchUnifiedHandleStatus', spaceName, subspace, e);
  }
  return { unifiedStatus: null, noServerPurchase: false };
}

function extractTxidFromListnumsEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const o = entry as Record<string, unknown>;
  for (const k of ['txid', 'tx_id', 'tx_hash', 'hash', 'transaction_id']) {
    const v = o[k];
    if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/i.test(v)) {
      return v.toLowerCase();
    }
  }
  return undefined;
}

/**
 * `GET /api/listnums-by-spk` — matches subspace: non-empty `nums` ⇒ on-chain.
 * `null` = request failed; do not change stored `chainPresence`.
 */
async function fetchListnumsChainSnapshot(
  baseUrl: string,
  scriptPubkeyHex: string
): Promise<{
  onChain: boolean;
  listnumsLastDataHex?: string;
  priorTxid?: string;
} | null> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/api/listnums-by-spk?script_pubkey=${encodeURIComponent(scriptPubkeyHex.trim())}`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const nums = Array.isArray(o.nums) ? o.nums : [];
    if (!res.ok) {
      console.warn('[Spaces] listnums-by-spk', { status: res.status });
      return null;
    }
    const onChain = nums.length > 0;
    let listnumsLastDataHex: string | undefined;
    let priorTxid: string | undefined;
    if (onChain) {
      const last = nums[nums.length - 1];
      if (last && typeof last === 'object' && 'data' in last) {
        const d = (last as { data?: unknown }).data;
        listnumsLastDataHex = typeof d === 'string' ? d : undefined;
      }
      priorTxid = extractTxidFromListnumsEntry(last);
    }
    return { onChain, listnumsLastDataHex, priorTxid };
  } catch (e) {
    console.warn('[Spaces] listnums-by-spk', e);
    return null;
  }
}

/** Unified statuses at or after on-chain payment confirmation. */
const PAYMENT_CONFIRMED_OR_LATER = new Set<string>([
  'confirmed',
  'proof_created',
  'proof_batched',
  'proof_committed',
  'certificate_pending',
  'certificate_delivered',
  'sptr_creating',
  'sptr_created',
  'sptr_delivered',
]);

/** Unified statuses at or after proof committed in the purchase pipeline. */
const PROOF_COMMITTED_OR_LATER = new Set<string>([
  'proof_committed',
  'certificate_pending',
  'certificate_delivered',
  'sptr_creating',
  'sptr_created',
  'sptr_delivered',
]);

type SubsHandleSnapshot = {
  subsStatus: string | null;
  scriptPubkeyHex: string | null;
  commitmentRoot: string | null;
  /** `null` while batch confirmation is in progress; `final` when published. */
  publishStatus?: string | null;
};

/**
 * GET /api/subsd/spaces/@{space}/handles/{subspace}
 * `staged` = payment confirmed; `committed` = batch commitment on-chain. Keep monitoring.
 */
async function fetchSubsHandleRecord(
  baseUrl: string,
  spaceName: string,
  subspace: string
): Promise<SubsHandleSnapshot | null> {
  const b = baseUrl.replace(/\/$/, '');
  const spaceSlug = `@${spaceName.toLowerCase()}`;
  const url = `${b}/api/subsd/spaces/${encodeURIComponent(spaceSlug)}/handles/${encodeURIComponent(subspace.trim())}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      console.warn('[Spaces] subs handle', { url, status: res.status, body });
      return null;
    }
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const subsStatus = typeof o.status === 'string' ? o.status.trim().toLowerCase() : null;
    const scriptPubkeyHex =
      typeof o.script_pubkey === 'string' && o.script_pubkey.trim()
        ? o.script_pubkey.trim().toLowerCase()
        : null;
    const commitmentRoot =
      typeof o.commitment_root === 'string' && o.commitment_root.trim()
        ? o.commitment_root.trim().toLowerCase()
        : null;
    const publishStatus =
      typeof o.publish_status === 'string' && o.publish_status.trim()
        ? o.publish_status.trim().toLowerCase()
        : null;
    console.log('[Spaces] subs handle', {
      url,
      subsStatus,
      scriptPubkeyHex,
      commitmentRoot,
      publishStatus,
    });
    return { subsStatus, scriptPubkeyHex, commitmentRoot, publishStatus };
  } catch (e) {
    console.warn('[Spaces] subs handle', url, e);
    return null;
  }
}

type SpacePipelineSteps = {
  broadcast?: string;
  confirmed?: string;
};

/** Batch is awaiting confirmation when broadcast finished and confirmation is in progress. */
function isPipelineBatchConfirming(steps: SpacePipelineSteps | null | undefined): boolean {
  return steps?.broadcast === 'complete' && steps?.confirmed === 'in_progress';
}

/**
 * GET /spaces/@{space}/pipeline — space-level batch pipeline (not per-handle).
 * Returns `null` when the request fails; do not change stored confirming state.
 */
async function fetchSpacePipelineBatchConfirming(
  baseUrl: string,
  spaceName: string
): Promise<boolean | null> {
  const b = baseUrl.replace(/\/$/, '');
  const spaceSlug = `@${spaceName.toLowerCase()}`;
  const url = `${b}/spaces/${encodeURIComponent(spaceSlug)}/pipeline`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const steps =
      o.steps && typeof o.steps === 'object' ? (o.steps as SpacePipelineSteps) : null;
    if (!res.ok || o.success === false) {
      console.warn('[Spaces] space pipeline', { url, status: res.status, body });
      return null;
    }
    if (
      !steps &&
      (typeof o.handle === 'string' || o.price != null || typeof o.state === 'string')
    ) {
      console.warn('[Spaces] space pipeline: unexpected handle payload', { url, body: o });
      return null;
    }
    if (!steps) {
      console.warn('[Spaces] space pipeline: missing steps', { url, body: o });
      return null;
    }
    const confirming = isPipelineBatchConfirming(steps);
    console.log('[Spaces] space pipeline', { url, confirming, steps });
    return confirming;
  } catch (e) {
    console.warn('[Spaces] space pipeline', url, e);
    return null;
  }
}

/**
 * Prefer space pipeline steps; when unavailable, infer from subs `publish_status`
 * (`null` ⇒ batch confirmation still in progress, `final` ⇒ settled).
 */
function resolveSubsBatchConfirming(
  subs: SubsHandleSnapshot | null | undefined,
  pipelineConfirming: boolean | null
): boolean | null {
  if (subs?.subsStatus !== 'committed') {
    return false;
  }
  if (pipelineConfirming !== null) {
    return pipelineConfirming;
  }
  if (subs.publishStatus === 'final') {
    return false;
  }
  if (subs.publishStatus == null) {
    return true;
  }
  return null;
}

function subsPipelineFieldsFromUpdate(
  subs: SubsHandleSnapshot | null | undefined,
  pipelineConfirming: boolean | null
): { subsPipelineBatchConfirming?: boolean } {
  const resolved = resolveSubsBatchConfirming(subs, pipelineConfirming);
  if (subs?.subsStatus !== 'committed') {
    return { subsPipelineBatchConfirming: false };
  }
  if (resolved === null) {
    return {};
  }
  return { subsPipelineBatchConfirming: resolved };
}

/** Track commitment_root for committed handles; flag when root changes on a later check. */
function subsCommitmentFieldsFromUpdate(
  prev: { subsCommitmentRoot?: string | null },
  subs: SubsHandleSnapshot | null | undefined
): {
  subsHandleStatus?: string | null;
  subsCommitmentRoot?: string | null;
  subsCommitmentRootConfirming?: boolean;
} {
  if (!subs) {
    return {};
  }

  if (subs.subsStatus === 'committed' && subs.commitmentRoot) {
    const prevRoot = prev.subsCommitmentRoot ?? null;
    const nextRoot = subs.commitmentRoot;
    return {
      subsHandleStatus: subs.subsStatus,
      subsCommitmentRoot: nextRoot,
      subsCommitmentRootConfirming: Boolean(prevRoot && prevRoot !== nextRoot),
    };
  }

  if (subs.subsStatus !== 'committed') {
    return {
      subsHandleStatus: subs.subsStatus,
      subsCommitmentRoot: null,
      subsCommitmentRootConfirming: false,
    };
  }

  return { subsHandleStatus: subs.subsStatus };
}

type TenantQuoteSnapshot = {
  found: boolean;
  paymentConfirmed: boolean | null;
};

/**
 * GET /tenant-quotes?space={space}&handle={subspace}
 * Used when handle is off-chain to detect awaiting payment vs staged.
 */
async function fetchTenantQuoteRecord(
  baseUrl: string,
  spaceName: string,
  subspace: string
): Promise<TenantQuoteSnapshot | null> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/tenant-quotes?space=${encodeURIComponent(spaceName.toLowerCase())}&handle=${encodeURIComponent(subspace.trim())}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      console.warn('[Spaces] tenant-quotes', { url, status: res.status, body });
      return null;
    }
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const found = o.found === true || o.success === true;
    const state =
      o.state && typeof o.state === 'object' ? (o.state as Record<string, unknown>) : null;
    const paymentConfirmed =
      state && typeof state.payment_confirmed === 'boolean' ? state.payment_confirmed : null;
    console.log('[Spaces] tenant-quotes', { url, found, paymentConfirmed });
    return { found, paymentConfirmed };
  } catch (e) {
    console.warn('[Spaces] tenant-quotes', url, e);
    return null;
  }
}

function tenantQuoteFieldsFromUpdate(
  row: {
    subsHandleStatus?: string | null;
    status: string;
  },
  subs: SubsHandleSnapshot | null | undefined,
  tenantQuote: TenantQuoteSnapshot | null | undefined,
  isOffChain: boolean
): {
  tenantQuotePaymentConfirmed?: boolean | null;
  subsHandleStatus?: string | null;
  status?: string;
} {
  if (!isOffChain || !tenantQuote?.found || tenantQuote.paymentConfirmed === null) {
    return {};
  }

  if (tenantQuote.paymentConfirmed === false) {
    return {
      tenantQuotePaymentConfirmed: false,
      status: 'pending_payment',
    };
  }

  const subsStatus = subs?.subsStatus ?? row.subsHandleStatus;
  if (subsStatus === 'committed' || subsStatus === 'staged') {
    return { tenantQuotePaymentConfirmed: true };
  }

  return {
    tenantQuotePaymentConfirmed: true,
    subsHandleStatus: 'staged',
  };
}

function mergeStatusWithSubsHandle(
  current: string | null | undefined,
  subsStatus: string | null | undefined
): string | null {
  if (!subsStatus) {
    return current ?? null;
  }
  if (subsStatus === 'committed') {
    if (current && PROOF_COMMITTED_OR_LATER.has(current)) {
      return current;
    }
    return 'proof_committed';
  }
  if (subsStatus === 'staged') {
    if (current && PAYMENT_CONFIRMED_OR_LATER.has(current)) {
      return current;
    }
    return 'confirmed';
  }
  return current ?? null;
}

/** POST purchase response may use `pointer_*` (current API) or legacy `sptr_*`. */
/** @see PURCHASE.md — `payment_watch.path` with `{jobId}`; body includes `transaction_id` after broadcast. */
type PaymentWatchSpec = {
  method?: string;
  path: string;
  body?: Record<string, unknown>;
};

/** API may use `purchase_id` (JSON) or `purchaseId` (some stacks); normalize to a number. */
function purchaseIdFromRecord(d: Record<string, unknown>): number | undefined {
  const v = d.purchase_id ?? d.purchaseId;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function purchaseIdFromResponseBodyText(text: string): number | undefined {
  const t = text?.trim();
  if (!t) {
    return undefined;
  }
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    return purchaseIdFromRecord(j);
  } catch {
    return undefined;
  }
}

function feeForDuration(
  duration: string,
  fee1: number | null,
  fee6: number | null,
  fee48: number | null
): number | null {
  switch (duration) {
    case '~10 mins':
      return fee1;
    case '~1 hour':
      return fee6;
    case '~8 hours':
      return fee48;
    default:
      return fee1;
  }
}

/** Satoshis the wallet should pay (coupon discount on price only; block_fee never discounted). */
function resolvePurchasePaymentAmountSats(params: {
  serverTotalPrice: number;
  priceSats: number | null;
  discountPercent: number | null;
  completelyFree: boolean;
  selectedDuration: string;
  blockFee1: number | null;
  blockFee6: number | null;
  blockFee48: number | null;
  takeOnchain: boolean;
  sptrPrice: number | null;
  sptrFee1: number | null;
  sptrFee6: number | null;
  sptrFee48: number | null;
}): number {
  if (params.completelyFree) return 0;
  if (params.discountPercent === null || params.priceSats === null) {
    return params.serverTotalPrice;
  }

  const blockFee = feeForDuration(
    params.selectedDuration,
    params.blockFee1,
    params.blockFee6,
    params.blockFee48
  ) ?? 0;
  const discountedPrice = Math.floor((params.priceSats * (100 - params.discountPercent)) / 100);
  let total = blockFee + discountedPrice;
  if (params.takeOnchain && params.sptrPrice !== null) {
    const sptrFee = feeForDuration(
      params.selectedDuration,
      params.sptrFee1,
      params.sptrFee6,
      params.sptrFee48
    );
    if (sptrFee !== null) {
      total += params.sptrPrice + sptrFee;
    }
  }
  return total;
}

function buildWatchPaymentRequestUrl(
  baseUrl: string,
  pathTemplate: string,
  jobId: number
): string {
  const p = pathTemplate
    .replace(/\{jobId\}/g, String(jobId))
    .replace(/\{job_id\}/g, String(jobId));
  if (/^https?:\/\//i.test(p)) {
    return p;
  }
  const b = baseUrl.replace(/\/$/, '');
  return `${b}${p.startsWith('/') ? p : `/${p}`}`;
}

async function postJobsWatchPayment(
  baseUrl: string,
  spec: PaymentWatchSpec,
  jobId: number,
  transactionId: string,
  logLabel: string,
  scriptPubKeyHex?: string
): Promise<{ ok: boolean; purchaseId?: number }> {
  if (!spec.path) {
    return { ok: false };
  }
  const url = buildWatchPaymentRequestUrl(baseUrl, spec.path, jobId);
  const method = (spec.method || 'POST').toUpperCase();
  const body = buildPaymentWatchRequestBody(spec.body, transactionId, { scriptPubKeyHex });
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const t = await res.text();
      console.error(`[Spaces API] ${method} ${url} - watch-payment (${ms}ms) [${logLabel}]`, t);
      return { ok: false };
    }
    const text = await res.text();
    const purchaseId = purchaseIdFromResponseBodyText(text);
    console.log(
      `[Spaces API] ${method} ${url} - watch-payment OK (${ms}ms) [${logLabel}]`,
      text || '(empty body)'
    );
    return { ok: true, purchaseId };
  } catch (e) {
    console.error(`[Spaces] watch-payment [${logLabel}]`, e);
    return { ok: false };
  }
}

async function postWatchPaymentFallback(
  baseUrl: string,
  jobId: number,
  spaceNameLower: string,
  transactionId: string,
  logLabel: string,
  scriptPubKeyHex?: string
): Promise<{ ok: boolean; purchaseId?: number }> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/api/jobs/${jobId}/watch-payment?space=${encodeURIComponent(spaceNameLower)}`;
  const start = Date.now();
  const body = buildPaymentWatchRequestBody(undefined, transactionId, { scriptPubKeyHex });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const t = await res.text();
      console.error(
        `[Spaces API] POST ${url} - watch-payment fallback (${ms}ms) [${logLabel}]`,
        t
      );
      return { ok: false };
    }
    const text = await res.text();
    const purchaseId = purchaseIdFromResponseBodyText(text);
    console.log(
      `[Spaces API] POST ${url} - watch-payment OK (${ms}ms) [${logLabel}]`,
      text || '(empty body)'
    );
    return { ok: true, purchaseId };
  } catch (e) {
    console.error(`[Spaces] watch-payment fallback [${logLabel}]`, e);
    return { ok: false };
  }
}

/** Server recognizes txids with this prefix as simulated (no on-chain payment). */
const SIMULATED_TXID_PREFIX = 'decafcafe';

function buildSimulatedTransactionId(jobId: number): string {
  const prefix = SIMULATED_TXID_PREFIX;
  const jobHex = jobId.toString(16).padStart(12, '0');
  const timeHex = Date.now().toString(16).padStart(12, '0');
  const tail = `${jobHex}${timeHex}`.slice(0, 64 - prefix.length);
  return `${prefix}${tail}`.padEnd(64, '0').slice(0, 64);
}

type PostPurchaseWatchState = {
  primary: PaymentWatchSpec | null;
  pointer: PaymentWatchSpec | null;
  primaryJobId: number | null;
  pointerJobId: number | null;
} | null;

async function registerPurchasePaymentOnServer(params: {
  baseUrl: string;
  transactionId: string;
  jobId: number;
  spaceNameLower: string;
  subspaceTrimmed: string;
  handle: string;
  paymentWatch: PostPurchaseWatchState;
  pendingPurchaseId?: number;
  /** First-time purchase: Taproot script pubkey for the reserved wallet path. */
  scriptPubKeyHex?: string;
  logLabel: string;
}): Promise<{ purchaseId?: number; watchOk: boolean; callbackOk: boolean }> {
  const {
    baseUrl,
    transactionId,
    jobId,
    spaceNameLower,
    subspaceTrimmed,
    handle,
    paymentWatch,
    pendingPurchaseId,
    scriptPubKeyHex,
    logLabel,
  } = params;

  let purchaseIdFromWatch: number | undefined;
  let watchOk = false;
  const w = paymentWatch;
  const primaryJobId = w?.primaryJobId ?? jobId;

  if (w?.primary && primaryJobId != null) {
    const r = await postJobsWatchPayment(
      baseUrl,
      w.primary,
      primaryJobId,
      transactionId,
      `${logLabel}-primary`,
      scriptPubKeyHex
    );
    if (r.purchaseId != null) {
      purchaseIdFromWatch = r.purchaseId;
    }
    watchOk = r.ok;
    if (!r.ok) {
      const fb = await postWatchPaymentFallback(
        baseUrl,
        primaryJobId,
        spaceNameLower,
        transactionId,
        `${logLabel}-primary-fallback`,
        scriptPubKeyHex
      );
      if (fb.purchaseId != null) {
        purchaseIdFromWatch = fb.purchaseId;
      }
      watchOk = watchOk || fb.ok;
    }
  } else if (primaryJobId != null) {
    const fb = await postWatchPaymentFallback(
      baseUrl,
      primaryJobId,
      spaceNameLower,
      transactionId,
      `${logLabel}-primary`,
      scriptPubKeyHex
    );
    if (fb.purchaseId != null) {
      purchaseIdFromWatch = fb.purchaseId;
    }
    watchOk = fb.ok;
  }

  if (w?.pointer && w.pointerJobId != null) {
    const pr = await postJobsWatchPayment(
      baseUrl,
      w.pointer,
      w.pointerJobId,
      transactionId,
      `${logLabel}-pointer`,
      scriptPubKeyHex
    );
    if (pr.purchaseId != null) {
      purchaseIdFromWatch = pr.purchaseId;
    }
    watchOk = watchOk && pr.ok;
    if (!pr.ok) {
      const pfb = await postWatchPaymentFallback(
        baseUrl,
        w.pointerJobId,
        spaceNameLower,
        transactionId,
        `${logLabel}-pointer-fallback`,
        scriptPubKeyHex
      );
      if (pfb.purchaseId != null) {
        purchaseIdFromWatch = pfb.purchaseId;
      }
      watchOk = watchOk || pfb.ok;
    }
  }

  const callbackUrl = `${baseUrl.replace(/\/$/, '')}/api/payments/callback?tenant=${encodeURIComponent(spaceNameLower)}`;
  const label = handle.includes('@') ? handle : `${subspaceTrimmed}@${spaceNameLower}`;

  let purchaseIdForCallback = pendingPurchaseId;
  if (purchaseIdForCallback == null) {
    try {
      const raw = await AsyncStorage.getItem(`spaces_purchase_${jobId}`);
      if (raw) {
        const fromStore = purchaseIdFromRecord(JSON.parse(raw) as Record<string, unknown>);
        if (fromStore != null) {
          purchaseIdForCallback = fromStore;
        }
      }
    } catch (e) {
      console.warn('[Spaces] payment callback: AsyncStorage read failed', e);
    }
  }
  if (purchaseIdForCallback == null && purchaseIdFromWatch != null) {
    purchaseIdForCallback = purchaseIdFromWatch;
  }

  let callbackOk = false;
  if (purchaseIdForCallback != null) {
    const cbStart = Date.now();
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transactionId,
          label,
          purchase_id: purchaseIdForCallback,
          ...(scriptPubKeyHex?.trim() ? { script_pubkey: scriptPubKeyHex.trim() } : {}),
        }),
      });
      const ms = Date.now() - cbStart;
      if (!res.ok) {
        const errText = await res.text();
        console.error(
          `[Spaces API] POST ${callbackUrl} - HTTP ${res.status} (${ms}ms) [${logLabel}]`,
          errText
        );
      } else {
        const bodyText = await res.text();
        console.log(
          `[Spaces API] POST ${callbackUrl} - Success (${ms}ms) [${logLabel}]`,
          bodyText || '(empty body)'
        );
        callbackOk = true;
      }
    } catch (e) {
      console.error(`[Spaces] POST payment callback failed [${logLabel}]:`, e);
    }
  } else {
    console.warn(
      `[Spaces] Skipping /api/payments/callback [${logLabel}]: missing purchase_id`,
      { jobId, hasTxid: !!transactionId }
    );
  }

  return {
    purchaseId: purchaseIdForCallback ?? purchaseIdFromWatch,
    watchOk,
    callbackOk,
  };
}

function pointerIdsFromPurchaseResponse(data: Record<string, unknown>): {
  pointerJobId?: number;
  pointerPurchaseId?: number;
} {
  const asPosInt = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.trunc(n);
  };
  return {
    pointerJobId: asPosInt(data.pointer_job_id ?? data.sptr_job_id),
    pointerPurchaseId: asPosInt(data.pointer_purchase_id ?? data.sptr_purchase_id),
  };
}

/** One row from POST /api/subsd/find-handles (flexible shapes). */
interface FindHandlesSpaceRow {
  subspace: string;
  spaceName: string;
  handle: string;
  /** From API `public_scriptkey` (or aliases); used for listnums / chainPresence. */
  scriptPubKeyHex?: string;
}

function mySpacesRowKey(subspace: string, spaceName: string): string {
  return `${subspace.trim()}\0${spaceName.trim().toLowerCase()}`;
}

/**
 * Extract subspace@space entries from find-handles JSON (handles, results, data, matches, etc.).
 */
function parseFindHandlesResponse(body: unknown): FindHandlesSpaceRow[] {
  const collected: FindHandlesSpaceRow[] = [];

  const addFromHandleString = (raw: string) => {
    const h = raw.trim();
    if (!h.includes('@')) return;
    const at = h.indexOf('@');
    const subspace = h.slice(0, at).trim();
    const spaceName = h.slice(at + 1).trim().toLowerCase();
    if (!subspace || !spaceName) return;
    collected.push({ subspace, spaceName, handle: `${subspace}@${spaceName}` });
  };

  const scriptKeyFromObject = (o: Record<string, unknown>): string | undefined => {
    const v =
      o.public_scriptkey ??
      o.public_script_key ??
      o.script_pubkey ??
      o.scriptPubkey ??
      o.scriptPubKey ??
      o.scriptPubKeyHex;
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  const addRow = (
    subspace?: unknown,
    spaceName?: unknown,
    handle?: unknown,
    scriptPubKeyHex?: string
  ) => {
    if (typeof handle === 'string' && handle.includes('@')) {
      addFromHandleString(handle);
      return;
    }
    if (typeof subspace === 'string' && typeof spaceName === 'string') {
      const sub = subspace.trim();
      const sn = spaceName.trim().toLowerCase();
      if (sub && sn) {
        collected.push({
          subspace: sub,
          spaceName: sn,
          handle: `${sub}@${sn}`,
          ...(scriptPubKeyHex ? { scriptPubKeyHex } : {}),
        });
      }
    }
  };

  const consumeArray = (arr: unknown[]) => {
    for (const item of arr) {
      if (typeof item === 'string') addFromHandleString(item);
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const spk = scriptKeyFromObject(o);
        const handleField = o.handle ?? o.full_handle ?? o.fullHandle ?? o.name;
        if (typeof handleField === 'string' && handleField.includes('@')) {
          const h = handleField.trim();
          const at = h.indexOf('@');
          const subspace = h.slice(0, at).trim();
          const spaceName = h.slice(at + 1).trim().toLowerCase();
          if (subspace && spaceName) {
            collected.push({
              subspace,
              spaceName,
              handle: `${subspace}@${spaceName}`,
              ...(spk ? { scriptPubKeyHex: spk } : {}),
            });
          }
          continue;
        }
        addRow(
          o.subspace ?? o.sub_name ?? o.subName,
          o.space ?? o.space_name ?? o.spaceName ?? o.domain,
          handleField,
          spk
        );
      }
    }
  };

  if (body == null) return [];

  if (Array.isArray(body)) {
    consumeArray(body);
  } else if (typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const arrays = [o.handles, o.results, o.data, o.items, o.matches, o.rows, o.spaces] as const;
    for (const a of arrays) {
      if (Array.isArray(a)) consumeArray(a);
    }
  }

  const byKey = new Map<string, FindHandlesSpaceRow>();
  for (const r of collected) {
    const k = mySpacesRowKey(r.subspace, r.spaceName);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, r);
    } else if (!prev.scriptPubKeyHex && r.scriptPubKeyHex) {
      byKey.set(k, { ...prev, scriptPubKeyHex: r.scriptPubKeyHex });
    }
  }
  return Array.from(byKey.values());
}

interface SpaceAvailabilityResponse {
  state: 'available' | 'taken' | 'unavailable';
  price?: number; // Price in sats
  '1_block_fee'?: number; // Block fee for ~10 mins in sats
  '6_block_fee'?: number; // Block fee for ~1 hour in sats
  '48_block_fee'?: number; // Block fee for ~8 hours in sats
  sptr_price?: number; // SPTR price
  '1_block_sptr_fee'?: number; // SPTR block fee for ~10 mins
  '6_block_sptr_fee'?: number; // SPTR block fee for ~1 hour
  '48_block_sptr_fee'?: number; // SPTR block fee for ~8 hours
  handle?: string;
  id?: number; // quote_id from API
  [key: string]: any;
}

interface SpaceItem {
  space_name: string;
  [key: string]: any;
}

interface GetSpacesResponse {
  spaces: SpaceItem[];
  [key: string]: any;
}

function parseSpacesApiErrorMessage(errorText: string): string | null {
  const trimmed = errorText.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    /* plain-text body */
  }
  return trimmed.length <= 240 ? trimmed : null;
}

function formatSpacesApiHttpError(status: number, errorText: string): string {
  return parseSpacesApiErrorMessage(errorText) ?? `Request failed (HTTP ${status})`;
}

function shouldRefreshQuoteAfterSpacesApiError(message: string): boolean {
  return /quote has been cancelled|quote.*cancelled|quote.*expired|invalid quote|quote not found/i.test(
    message
  );
}

class SpacesApiHttpError extends Error {
  readonly httpStatus: number;
  readonly refreshQuote: boolean;

  constructor(httpStatus: number, errorText: string) {
    const message = formatSpacesApiHttpError(httpStatus, errorText);
    super(message);
    this.name = 'SpacesApiHttpError';
    this.httpStatus = httpStatus;
    this.refreshQuote = shouldRefreshQuoteAfterSpacesApiError(message);
  }
}

function throwSpacesApiHttpError(httpStatus: number, errorText: string): never {
  throw new SpacesApiHttpError(httpStatus, errorText);
}

export default function SpacesScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const { wallet, addresses, balances } = useWallet();
  const [subspace, setSubspace] = useState('');
  const [spaceName, setSpaceName] = useState<string>('');
  /** Avoid repeating the "select space name first" warning on every subspace keystroke. */
  const subspaceBeforeSpaceNameWarnedRef = useRef(false);
  /** Throttle pricing-unavailable toasts during the 30s refresh interval. */
  const pricingUnavailableToastAtRef = useRef(0);
  /** Latest availability/quote refresh (for stale-quote recovery after POST/PUT failures). */
  const refreshSpaceQuoteRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const handleSpacesPurchaseApiErrorRef = useRef<
    (error: unknown, logContext: string) => void
  >(() => {});
  /** Set when POST/PUT confirms a purchase so broadcast can POST /api/payments/callback even if mySpaces hasn’t re-rendered yet. */
  const pendingPaymentCallbackRef = useRef<{ jobId: number; purchaseId: number } | null>(null);
  /** From successful POST /spaces/... (PURCHASE.md `payment_watch` / `pointer_payment_watch`); used after broadcast. */
  const postPurchaseWatchRef = useRef<{
    primary: PaymentWatchSpec | null;
    pointer: PaymentWatchSpec | null;
    primaryJobId: number | null;
    pointerJobId: number | null;
  } | null>(null);
  /** Taproot path + script pubkey reserved after PUT confirm (first-time purchase). */
  const purchaseTaprootPathRef = useRef<{
    fullPath: string;
    relativePath: string;
    scriptPubKeyHex: string;
    address: string;
  } | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [buttonState, setButtonState] = useState<
    'available' | 'taken' | 'reserved' | 'loading' | null
  >(null);
  const [isButtonEnabled, setIsButtonEnabled] = useState(false);
  const [buttonLabel, setButtonLabel] = useState(EMPTY_SUBSPACE_BUTTON_LABEL);
  const [selectedDuration, setSelectedDuration] = useState<string>('~8 hours');
  const [priceSats, setPriceSats] = useState<number | null>(null);
  const [blockFee1, setBlockFee1] = useState<number | null>(null);
  const [blockFee6, setBlockFee6] = useState<number | null>(null);
  const [blockFee48, setBlockFee48] = useState<number | null>(null);
  const [sptrPrice, setSptrPrice] = useState<number | null>(null);
  const [sptrFee1, setSptrFee1] = useState<number | null>(null);
  const [sptrFee6, setSptrFee6] = useState<number | null>(null);
  const [sptrFee48, setSptrFee48] = useState<number | null>(null);
  const [takeOnchain, setTakeOnchain] = useState(false);
  const [spaceNameOptions, setSpaceNameOptions] = useState<string[]>(SPACE_NAME_OPTIONS);
  const [btcPriceUSD, setBtcPriceUSD] = useState<number | null>(null);
  const [quoteId, setQuoteId] = useState<number | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [isConfirmationMode, setIsConfirmationMode] = useState(false);
  const [couponCode, setCouponCode] = useState<string>('');
  const [discountPercent, setDiscountPercent] = useState<number | null>(null);
  const [completelyFree, setCompletelyFree] = useState(false);
  const [couponStatus, setCouponStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle');
  const [purchaseData, setPurchaseData] = useState<{
    taproot_address: string;
    handle: string;
    total_price: number;
    expiring_blockheight: number;
  } | null>(null);
  const [showTxHexModal, setShowTxHexModal] = useState(false);
  const [txHex, setTxHex] = useState<string>('');
  const [txHexData, setTxHexData] = useState<{
    scriptType: 'P2TR' | 'P2WPKH' | 'P2PKH';
    network: NetworkType;
    accountIndex: number;
    amount: number;
    recipientAddress: string;
    asset: AssetTicker;
    memo?: string;
  } | null>(null);
  type UnifiedStatus =
    | 'pending_payment'
    | 'processing'
    | 'confirmed'
    | 'proof_created'
    | 'proof_batched'
    | 'proof_committed'
    | 'certificate_pending'
    | 'certificate_delivered'
    | 'sptr_creating'
    | 'sptr_created'
    | 'sptr_delivered'
    | 'expired'
    | 'cancelled'
    | 'purchasing' // Legacy status for backward compatibility
    | 'requesting' // Free coupon: no transaction needed
    | 'discovered'; // From Find Spaces scan; no job polling

  const [mySpaces, setMySpaces] = useState<
    {
      subspace: string;
      spaceName: string;
      handle: string;
      status: UnifiedStatus;
      jobId?: number; // Primary job ID (subname)
      sptrJobId?: number; // SPTR job ID (if applicable)
      purchaseId?: number; // Subname purchase ID
      sptrPurchaseId?: number; // SPTR purchase ID
      hasSptr?: boolean; // Whether this purchase includes SPTR
      /** Taproot script pubkey hex (e.g. from Find Spaces scan); used for listnums-by-spk. */
      scriptPubKeyHex?: string;
      /** BIP-86 full derivation path when reserved at purchase time. */
      taprootDerivationPath?: string;
      /** Set on space details when purchase status was unknown; from GET /api/listnums-by-spk. */
      chainPresence?: 'on-chain' | 'off-chain';
      /** Last `nums` entry `data` when chainPresence is on-chain. */
      listnumsLastDataHex?: string;
      /** User-saved wire hex from Hex Tool (Save Hex String). */
      newDataHex?: string;
      /**
       * Which `purchase_type` the unified status API should use (defaults to subname).
       * Set to `pointer` for Take on-chain / standalone pointer purchases.
       */
      unifiedStatusPurchaseType?: 'subname' | 'pointer';
      /** Raw status from GET /api/subsd/spaces/@{space}/handles/{subspace} (e.g. `staged`). */
      subsHandleStatus?: string | null;
      /** Latest commitment_root when subs status is `committed`. */
      subsCommitmentRoot?: string | null;
      /** True when commitment_root changed since the prior check. */
      subsCommitmentRootConfirming?: boolean;
      /** True when space pipeline has broadcast complete and confirmation in progress. */
      subsPipelineBatchConfirming?: boolean;
      /** `state.payment_confirmed` from GET /tenant-quotes when off-chain. */
      tenantQuotePaymentConfirmed?: boolean | null;
    }[]
  >([]);
  const [jobPollingState, setJobPollingState] = useState<
    Record<
      number,
      {
        delay: number;
        nextCheckTime: number;
        attempt: number;
        isPolling: boolean;
      }
    >
  >({});
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
  const [currentJobData, setCurrentJobData] = useState<{
    handle: string;
    subspace: string;
    spaceName: string;
  } | null>(null);

  // Placeholder handlers - customize these based on your needs
  const handleSpacePress = (spaceId: string) => {
    // TODO: Navigate to space details or open space
    console.log('Space pressed:', spaceId);
  };

  const [isFindPurchaseExpanded, setIsFindPurchaseExpanded] = useState(true);
  const [isMySpacesExpanded, setIsMySpacesExpanded] = useState(true);
  const [isQuerySubspaceExpanded, setIsQuerySubspaceExpanded] = useState(false);
  const anchorsJsonRef = useRef<AnchorsResponse | null>(null);
  const anchorsJsonStringRef = useRef<string | null>(null);
  const anchorsPeerUrlRef = useRef<string | null>(null);
  const anchorsPeerUrlsRef = useRef<string[]>([]);
  const queryResponseRef = useRef<ArrayBuffer | null>(null);
  const verifyResultRef = useRef<unknown | null>(null);
  const querySearchInFlightRef = useRef(false);
  const [anchorsServerHostname, setAnchorsServerHostname] = useState<string | null>(null);
  const [anchorsReady, setAnchorsReady] = useState(false);
  const [querySpacesName, setQuerySpacesName] = useState('');
  const [isQuerySearchInFlight, setIsQuerySearchInFlight] = useState(false);
  const [queryVerifiedZones, setQueryVerifiedZones] = useState<VerifiedZoneSummary[]>([]);
  const [queryVerifyError, setQueryVerifyError] = useState<string | null>(null);
  const [queryRequestedHandleFound, setQueryRequestedHandleFound] = useState<boolean | null>(null);
  const [queryNoDns, setQueryNoDns] = useState(false);
  const [isAboutSpacesExpanded, setIsAboutSpacesExpanded] = useState(false);
  const [isRefreshingMySpacesStatuses, setIsRefreshingMySpacesStatuses] = useState(false);

  const handleSubspaceSelect = (space: (typeof mySpaces)[number]) => {
    const statusLabel = getSpaceStatus(space.subspace, space.spaceName);
    router.push({
      pathname: '/subspace',
      params: {
        subspace: space.subspace,
        spaceName: space.spaceName,
        statusLabel,
        ...(space.scriptPubKeyHex ? { scriptPubKeyHex: space.scriptPubKeyHex } : {}),
      },
    });
  };

  const loadQueryAnchors = useCallback(async (noDns: boolean) => {
    try {
      const result = await getAnchorsJSON({ noDns });
      if (!result) {
        anchorsJsonRef.current = null;
        anchorsJsonStringRef.current = null;
        anchorsPeerUrlRef.current = null;
        anchorsPeerUrlsRef.current = [];
        verifyResultRef.current = null;
        setQueryVerifiedZones([]);
        setQueryVerifyError(null);
        setQueryRequestedHandleFound(null);
        setAnchorsServerHostname(null);
        setAnchorsReady(false);
        console.warn(
          `[Spaces] getAnchorsJSON returned no anchor entries${noDns ? ' (No-DNS mode)' : ''}`
        );
        return;
      }

      anchorsJsonRef.current = result.anchors;
      anchorsJsonStringRef.current = formatAnchorsJsonForLibveritas(result.anchors);
      anchorsPeerUrlRef.current = result.peerUrl;
      anchorsPeerUrlsRef.current = result.peerUrls;
      setAnchorsServerHostname(result.serverHostname);
      setAnchorsReady(true);
      console.log('[Spaces] anchors servers:', result.serverHostname);
      console.log('[Spaces] query peers:', result.peerUrls.join(' | '));
      if (result.anchors.entries[0]) {
        console.log(
          '[Spaces] anchors first entry:',
          JSON.stringify(result.anchors.entries[0], null, 2)
        );
      }
    } catch (error) {
      anchorsJsonRef.current = null;
      anchorsJsonStringRef.current = null;
      anchorsPeerUrlRef.current = null;
      anchorsPeerUrlsRef.current = [];
      verifyResultRef.current = null;
      setQueryVerifiedZones([]);
      setQueryVerifyError(null);
      setQueryRequestedHandleFound(null);
      setAnchorsServerHostname(null);
      setAnchorsReady(false);
      console.warn('[Spaces] getAnchorsJSON failed', error);
    }
  }, []);

  const handleQuerySubspaceExpanded = useCallback(() => {
    console.log('[Spaces] Query Subspace section expanded');
    void loadQueryAnchors(queryNoDns);
  }, [loadQueryAnchors, queryNoDns]);

  const handleQueryNoDnsChange = useCallback(
    (enabled: boolean) => {
      setQueryNoDns(enabled);
      if (isQuerySubspaceExpanded) {
        void loadQueryAnchors(enabled);
      }
    },
    [isQuerySubspaceExpanded, loadQueryAnchors]
  );

  const handleQuerySpacesSearch = useCallback(async () => {
    const peerUrls = anchorsPeerUrlsRef.current;
    const spacesName = querySpacesName.trim();
    if (peerUrls.length === 0 || !spacesName || querySearchInFlightRef.current) {
      return;
    }

    querySearchInFlightRef.current = true;
    setIsQuerySearchInFlight(true);
    setQueryVerifiedZones([]);
    setQueryVerifyError(null);
    setQueryRequestedHandleFound(null);

    try {
      const anchorsJsonString = anchorsJsonStringRef.current;
      if (!anchorsJsonString) {
        verifyResultRef.current = null;
        setQueryVerifyError('Anchors unavailable — expand Query Subspace again.');
        console.warn('[Spaces] verify skipped: anchors JSON unavailable');
        return;
      }

      console.log('[Spaces] loading libveritas for verification…');
      const { resolveSpacesQuery } = await import('@/utils/resolve-spaces-query');
      const resolved = await resolveSpacesQuery(peerUrls, anchorsJsonString, spacesName, {
        noDns: queryNoDns,
      });
      verifyResultRef.current = resolved.raw;
      setQueryVerifiedZones(resolved.zones);
      setQueryRequestedHandleFound(resolved.requestedHandleFound);
      setQueryVerifyError(
        resolved.requestedHandleFound
          ? null
          : resolved.warning ??
              `Verified parent chain only. ${spacesName} is not yet available from this relay with a full certificate chain.`
      );
      console.log(
        `[Spaces] verify success: q=${spacesName}, zones=${resolved.zones.length}, requestedFound=${resolved.requestedHandleFound}, queryParts=${resolved.queryUrlParts.join(' | ')}`
      );
    } catch (error) {
      queryResponseRef.current = null;
      verifyResultRef.current = null;
      setQueryVerifiedZones([]);
      setQueryRequestedHandleFound(null);
      setQueryVerifyError(
        error instanceof Error
          ? error.message
          : 'Query or verification failed'
      );
      console.warn(`[Spaces] query failure: q=${spacesName}`, error);
    } finally {
      querySearchInFlightRef.current = false;
      setIsQuerySearchInFlight(false);
    }
  }, [querySpacesName, queryNoDns]);

  const handleQuerySubspaceCollapsed = useCallback(() => {
    console.log('[Spaces] Query Subspace section collapsed');
  }, []);

  const toggleQuerySubspaceExpanded = useCallback(() => {
    if (isQuerySubspaceExpanded) {
      handleQuerySubspaceCollapsed();
      setIsQuerySubspaceExpanded(false);
    } else {
      handleQuerySubspaceExpanded();
      setIsQuerySubspaceExpanded(true);
    }
  }, [isQuerySubspaceExpanded, handleQuerySubspaceExpanded, handleQuerySubspaceCollapsed]);


  const getSpaceStatus = (subspace: string, spaceName: string): string => {
    const space = mySpaces.find((s) => s.subspace === subspace && s.spaceName === spaceName);
    return formatMySpaceHandleStatusLabel(space);
  };

  const getTimeUntilNextCheck = (subspace: string, spaceName: string): number | null => {
    const space = mySpaces.find((s) => s.subspace === subspace && s.spaceName === spaceName);
    if (!space || !space.jobId) return null;

    const pollingState = jobPollingState[space.jobId];
    if (!pollingState || !pollingState.isPolling) return null;

    const now = Date.now();
    const timeRemaining = pollingState.nextCheckTime - now;
    if (timeRemaining <= 0) return 0;
    // Return minutes (rounded to 1 decimal place)
    return Math.round((timeRemaining / 60000) * 10) / 10;
  };

  const handleRefreshAllMySpacesStatuses = useCallback(async () => {
    if (mySpaces.length === 0) {
      toast.info('No spaces in My Spaces');
      return;
    }
    if (isRefreshingMySpacesStatuses) {
      return;
    }

    setIsRefreshingMySpacesStatuses(true);
    try {
      const [unifiedRows, listnumsRows, subsRows] = await Promise.all([
        Promise.all(
          mySpaces.map(async (space) => {
            const r = await fetchUnifiedHandleStatus(
              SPACES_API_BASE_URL,
              space.spaceName,
              space.subspace,
              space.unifiedStatusPurchaseType
            );
            return {
              key: `${space.subspace}\0${space.spaceName.toLowerCase()}`,
              unifiedStatus: r.unifiedStatus,
              noServerPurchase: r.noServerPurchase,
            };
          })
        ),
        Promise.all(
          mySpaces.map(async (space) => {
            const key = `${space.subspace}\0${space.spaceName.toLowerCase()}`;
            const spk = space.scriptPubKeyHex?.trim();
            if (!spk) {
              return { key, listnumsSnapshot: null as null };
            }
            const listnumsSnapshot = await fetchListnumsChainSnapshot(SPACES_API_BASE_URL, spk);
            return { key, listnumsSnapshot };
          })
        ),
        Promise.all(
          mySpaces.map(async (space) => {
            const key = `${space.subspace}\0${space.spaceName.toLowerCase()}`;
            const subsSnapshot = await fetchSubsHandleRecord(
              SPACES_API_BASE_URL,
              space.spaceName,
              space.subspace
            );
            return { key, subsSnapshot };
          })
        ),
      ]);

      const byKey = new Map<string, string>();
      let noServerPurchaseCount = 0;
      let otherFailureCount = 0;
      for (const r of unifiedRows) {
        if (r.unifiedStatus) {
          byKey.set(r.key, r.unifiedStatus);
        } else if (r.noServerPurchase) {
          noServerPurchaseCount += 1;
        } else {
          otherFailureCount += 1;
        }
      }

      const listnumsByKey = new Map<
        string,
        { onChain: boolean; listnumsLastDataHex?: string; priorTxid?: string }
      >();
      let onChainFromListnums = 0;
      for (const r of listnumsRows) {
        if (r.listnumsSnapshot) {
          listnumsByKey.set(r.key, r.listnumsSnapshot);
          if (r.listnumsSnapshot.onChain) {
            onChainFromListnums += 1;
          }
        }
      }

      const subsByKey = new Map<string, SubsHandleSnapshot>();
      for (const r of subsRows) {
        if (r.subsSnapshot) {
          subsByKey.set(r.key, r.subsSnapshot);
        }
      }

      const pipelineSpacesToCheck = new Set<string>();
      for (const space of mySpaces) {
        const k = `${space.subspace}\0${space.spaceName.toLowerCase()}`;
        if (subsByKey.get(k)?.subsStatus === 'committed') {
          pipelineSpacesToCheck.add(space.spaceName.toLowerCase());
        }
      }

      const pipelineBySpace = new Map<string, boolean>();
      await Promise.all(
        [...pipelineSpacesToCheck].map(async (spaceName) => {
          const confirming = await fetchSpacePipelineBatchConfirming(
            SPACES_API_BASE_URL,
            spaceName
          );
          if (confirming !== null) {
            pipelineBySpace.set(spaceName, confirming);
          }
        })
      );

      const offChainForTenantQuote = mySpaces.filter((space) => {
        const k = `${space.subspace}\0${space.spaceName.toLowerCase()}`;
        const snap = listnumsByKey.get(k);
        if (snap) {
          return !snap.onChain;
        }
        return space.chainPresence !== 'on-chain';
      });

      const tenantQuoteRows = await Promise.all(
        offChainForTenantQuote.map(async (space) => {
          const key = `${space.subspace}\0${space.spaceName.toLowerCase()}`;
          const tenantQuote = await fetchTenantQuoteRecord(
            SPACES_API_BASE_URL,
            space.spaceName,
            space.subspace
          );
          return { key, tenantQuote };
        })
      );

      const tenantQuoteByKey = new Map<string, TenantQuoteSnapshot>();
      for (const r of tenantQuoteRows) {
        if (r.tenantQuote) {
          tenantQuoteByKey.set(r.key, r.tenantQuote);
        }
      }

      setMySpaces((prev) =>
        prev.map((row) => {
          const k = `${row.subspace}\0${row.spaceName.toLowerCase()}`;
          const st = byKey.get(k);
          const snap = listnumsByKey.get(k);
          const subs = subsByKey.get(k);
          const mergedStatus = mergeStatusWithSubsHandle(st, subs?.subsStatus);
          let next = row;
          if (mergedStatus) {
            next = { ...next, status: mergedStatus as UnifiedStatus };
          }
          if (subs?.scriptPubkeyHex && !next.scriptPubKeyHex?.trim()) {
            next = { ...next, scriptPubKeyHex: subs.scriptPubkeyHex };
          }
          if (subs) {
            next = {
              ...next,
              ...subsCommitmentFieldsFromUpdate(next, subs),
              ...subsPipelineFieldsFromUpdate(
                subs,
                pipelineBySpace.get(row.spaceName.toLowerCase()) ?? null
              ),
            };
          }
          if (snap) {
            if (snap.onChain) {
              next = {
                ...next,
                chainPresence: 'on-chain',
                listnumsLastDataHex: snap.listnumsLastDataHex,
                priorTxid: snap.priorTxid,
                tenantQuotePaymentConfirmed: null,
              };
            } else {
              next = {
                ...next,
                chainPresence: 'off-chain',
                listnumsLastDataHex: undefined,
                priorTxid: undefined,
              };
            }
          }
          const isOffChain = next.chainPresence !== 'on-chain';
          const tenantQuote = tenantQuoteByKey.get(k);
          if (isOffChain) {
            if (tenantQuote) {
              next = {
                ...next,
                ...tenantQuoteFieldsFromUpdate(next, subs, tenantQuote, true),
              };
            } else {
              next = { ...next, tenantQuotePaymentConfirmed: null };
            }
          }
          return next;
        })
      );

      let statusUpdateCount = 0;
      for (const row of mySpaces) {
        const k = `${row.subspace}\0${row.spaceName.toLowerCase()}`;
        if (mergeStatusWithSubsHandle(byKey.get(k), subsByKey.get(k)?.subsStatus)) {
          statusUpdateCount += 1;
        }
      }
      const n = statusUpdateCount;
      if (n > 0) {
        toast.success(
          n === mySpaces.length
            ? 'Handle status updated'
            : `Updated ${n} of ${mySpaces.length} handles`
        );
      } else if (onChainFromListnums > 0) {
        toast.success(
          onChainFromListnums === mySpaces.length
            ? 'On-chain status updated'
            : `On-chain: ${onChainFromListnums} of ${mySpaces.length} handle(s) (by script key)`
        );
      } else if (otherFailureCount > 0) {
        toast.error('Could not fetch handle status. Check your connection or server.');
      }
    } finally {
      setIsRefreshingMySpacesStatuses(false);
    }
  }, [mySpaces, isRefreshingMySpacesStatuses]);

  const handleCopyTxHex = async () => {
    try {
      await Clipboard.setStringAsync(txHex);
      toast.success('Transaction hex copied to clipboard');
    } catch (error) {
      console.error('[Spaces] Failed to copy transaction hex:', error);
      Alert.alert('Error', 'Failed to copy transaction hex to clipboard');
    }
  };

  const finishPurchaseTxFlow = useCallback(() => {
    setShowTxHexModal(false);
    setSubspace('');
    subspaceBeforeSpaceNameWarnedRef.current = false;
    setButtonState(null);
    setIsButtonEnabled(false);
    setButtonLabel(EMPTY_SUBSPACE_BUTTON_LABEL);
  }, []);

  const handleFindSpaces = async () => {
    const fullPaths = buildSpacesScanDerivationPaths();
    console.log('[Spaces] Find Spaces — derivation paths:', JSON.stringify(fullPaths));
    if (fullPaths.length === 0) {
      toast.error('Set EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER and EXPO_PUBLIC_SPACES_ACCOUNT_GAP in .env');
      return;
    }

    const { bip, coinType } = getBitcoinTaprootPathPrefix();
    const relativePaths: string[] = [];
    for (const p of fullPaths) {
      const rel = fullPathToWalletRelativePath(p, bip, coinType);
      if (rel == null) {
        console.error('[Spaces] Find Spaces — path does not match config prefix:', p);
        toast.error('Derivation path prefix mismatch with wallet config');
        return;
      }
      relativePaths.push(rel);
    }

    try {
      const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths(relativePaths);
      const entries = JSON.parse(addressesJson) as { address: string; scriptPubKeyHex: string }[];
      const pathAndAddress = fullPaths.map((path, i) => {
        const row = entries[i];
        return {
          path,
          address: row?.address ?? null,
          scriptPubKeyHex: row?.scriptPubKeyHex ?? null,
        };
      });
      console.log('[Spaces] Find Spaces — taproot addresses & scriptPubKeys:', JSON.stringify(pathAndAddress));

      const scriptPubkeys = entries
        .map((e) => e.scriptPubKeyHex)
        .filter((h): h is string => typeof h === 'string' && h.length > 0);
      if (scriptPubkeys.length > 0) {
        try {
          const findHandlesUrl = `${SPACES_API_BASE_URL}/api/subsd/find-handles?app=${SPACES_APP_NAME}`;
          console.log('[Spaces] Find Spaces — POST', findHandlesUrl, { script_pubkeys: scriptPubkeys });
          const findRes = await fetch(findHandlesUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ script_pubkeys: scriptPubkeys }),
          });
          const findText = await findRes.text();
          let findData: unknown;
          try {
            findData = findText ? JSON.parse(findText) : null;
          } catch {
            findData = findText;
          }
          console.log('[Spaces] Find Spaces — find-handles response:', {
            ok: findRes.ok,
            status: findRes.status,
            body: findData,
          });
          if (!findRes.ok) {
            toast.error(`find-handles failed (${findRes.status})`);
          } else if (findData !== null && typeof findData === 'object') {
            const fd = findData as Record<string, unknown>;
            if (fd.success === false) {
              console.log('[Spaces] Find Spaces — find-handles success:false, skipping My Spaces merge');
            } else {
              const parsed = parseFindHandlesResponse(findData);
              console.log('[Spaces] Find Spaces — parsed handles:', JSON.stringify(parsed));
              if (parsed.length > 0) {
                setMySpaces((prev) => {
                  const seen = new Set(prev.map((s) => mySpacesRowKey(s.subspace, s.spaceName)));
                  const toAdd = parsed.filter((p) => !seen.has(mySpacesRowKey(p.subspace, p.spaceName)));
                  if (toAdd.length === 0) {
                    console.log('[Spaces] Find Spaces — no new handles (all already in My Spaces)');
                    return prev;
                  }
                  console.log(
                    '[Spaces] Find Spaces — adding',
                    toAdd.length,
                    'handle(s) to My Spaces (no polling):',
                    JSON.stringify(toAdd)
                  );
                  return [
                    ...prev,
                    ...toAdd.map((p) => {
                      let scriptPubKeyHex: string | undefined = p.scriptPubKeyHex;
                      if (!scriptPubKeyHex && parsed.length === scriptPubkeys.length) {
                        const idx = parsed.findIndex(
                          (r) =>
                            r.subspace === p.subspace && r.spaceName === p.spaceName
                        );
                        if (idx >= 0) scriptPubKeyHex = scriptPubkeys[idx];
                      }
                      return {
                        subspace: p.subspace,
                        spaceName: p.spaceName,
                        handle: p.handle,
                        status: 'discovered' as UnifiedStatus,
                        ...(scriptPubKeyHex ? { scriptPubKeyHex } : {}),
                      };
                    }),
                  ];
                });
              }
            }
          }
        } catch (findErr) {
          console.error('[Spaces] Find Spaces — find-handles request failed:', findErr);
          toast.error(
            findErr instanceof Error ? findErr.message : 'find-handles request failed'
          );
        }
      }
    } catch (error) {
      console.error('[Spaces] Find Spaces — derive addresses failed:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to derive addresses');
    }
  };

  const pollJobStatus = async (
    jobId: number,
    spaceName: string,
    subspace: string,
    options: {
      initialDelay?: number;
      maxDelay?: number;
      maxAttempts?: number;
      /** @default 'subname' — use `pointer` for Take on-chain / standalone pointer. */
      unifiedStatusPurchaseType?: 'subname' | 'pointer';
    } = {}
  ) => {
    const {
      initialDelay = 2000, // Start with 2 seconds
      maxDelay = 300000, // Max 5 minutes
      maxAttempts = 100,
      unifiedStatusPurchaseType = 'subname',
    } = options;

    const spaceNameLower = spaceName.toLowerCase();
    const existingSpace = mySpaces.find(
      (s) => s.subspace === subspace && s.spaceName === spaceNameLower
    );
    if (existingSpace?.chainPresence === 'on-chain') {
      console.log(
        `[Spaces] pollJobStatus: skip — ${subspace}@${spaceNameLower} already on-chain`
      );
      return null;
    }

    if (activePurchaseJobPolls.has(jobId)) {
      console.log(`[Spaces] pollJobStatus: skip duplicate for job ${jobId}`);
      return null;
    }
    activePurchaseJobPolls.add(jobId);

    const purchaseTypeQuery =
      unifiedStatusPurchaseType === 'pointer' ? PURCHASE_TYPE_POINTER : PURCHASE_TYPE_SUBNAME;
    let pointerPaymentConfirmToastShown = false;
    let subsPaymentConfirmToastShown = false;
    const paymentConfirmedOrLater = new Set<string>([
      'confirmed',
      'proof_created',
      'proof_batched',
      'proof_committed',
      'certificate_pending',
      'certificate_delivered',
      'sptr_creating',
      'sptr_created',
      'sptr_delivered',
    ]);

    let delay = initialDelay;
    let attempt = 0;

    const url = `${SPACES_API_BASE_URL}/api/jobs/${jobId}?space=${encodeURIComponent(spaceName)}`;

    const updatePollingState = (nextCheckTime: number, isPolling: boolean) => {
      setJobPollingState((prev) => ({
        ...prev,
        [jobId]: {
          delay,
          nextCheckTime,
          attempt,
          isPolling,
        },
      }));
    };

    const markSpaceOnChainFromListnums = (
      listnumsSnapshot: NonNullable<Awaited<ReturnType<typeof fetchListnumsChainSnapshot>>>
    ) => {
      setMySpaces((prev) =>
        prev.map((space) => {
          if (space.subspace !== subspace || space.spaceName !== spaceNameLower) {
            return space;
          }
          return {
            ...space,
            chainPresence: 'on-chain' as const,
            listnumsLastDataHex: listnumsSnapshot.listnumsLastDataHex,
            priorTxid: listnumsSnapshot.priorTxid,
            tenantQuotePaymentConfirmed: null,
          };
        })
      );
    };

    const updateSpaceStatus = (
      status: UnifiedStatus,
      subsSnapshot?: SubsHandleSnapshot | null,
      tenantQuote?: TenantQuoteSnapshot | null,
      pipelineBatchConfirming?: boolean | null
    ) => {
      setMySpaces((prev) =>
        prev.map((space) => {
          if (space.subspace !== subspace || space.spaceName !== spaceNameLower) {
            return space;
          }
          const isOffChain = space.chainPresence !== 'on-chain';
          const tenantFields =
            isOffChain && tenantQuote
              ? tenantQuoteFieldsFromUpdate(space, subsSnapshot, tenantQuote, true)
              : isOffChain && tenantQuote === null
                ? { tenantQuotePaymentConfirmed: null as null }
                : {};
          return {
            ...space,
            status: (tenantFields.status as UnifiedStatus | undefined) ?? status,
            jobId,
            unifiedStatusPurchaseType,
            ...(subsSnapshot?.scriptPubkeyHex && !space.scriptPubKeyHex?.trim()
              ? { scriptPubKeyHex: subsSnapshot.scriptPubkeyHex }
              : {}),
            ...(subsSnapshot ? subsCommitmentFieldsFromUpdate(space, subsSnapshot) : {}),
            ...(subsSnapshot
              ? subsPipelineFieldsFromUpdate(subsSnapshot, pipelineBatchConfirming)
              : {}),
            ...tenantFields,
          };
        })
      );
    };

    // Unified status: subname (default) vs pointer (Take on-chain standalone).
    const unifiedStatusUrl = `${SPACES_API_BASE_URL}/api/purchases/${encodeURIComponent(spaceName)}/${encodeURIComponent(subspace)}/status?purchase_type=${purchaseTypeQuery}`;

    try {
      while (attempt < maxAttempts) {
        try {
          // Set next check time (for first attempt, this is immediate, then uses delay)
          const nextCheckTime = attempt === 0 ? Date.now() : Date.now() + delay;
          updatePollingState(nextCheckTime, true);
          console.log(
            `[Spaces] Polling job ${jobId} (purchase_type=${purchaseTypeQuery}) - attempt ${
              attempt + 1
            }${attempt > 0 ? `, next check in ${delay}ms` : ' (immediate)'}`
          );

          // Try unified status endpoint first, fallback to job status endpoint
          let response;
          let data;
          let unifiedStatus: UnifiedStatus | null = null;

          try {
            response = await fetch(unifiedStatusUrl);
            data = await response.json();
            if (data.success && data.unified_status) {
              unifiedStatus = data.unified_status as UnifiedStatus;
              console.log(
                `[Spaces] Got unified status: ${unifiedStatus} for ${subspace}@${spaceName}`
              );
            }
          } catch (unifiedError) {
            console.warn(
              `[Spaces] Unified status endpoint failed, falling back to job status:`,
              unifiedError
            );
            // Fallback to job status endpoint
            response = await fetch(url);
            data = await response.json();
          }

          if (!data.success) {
            throw new Error(data.message || 'Failed to fetch job status');
          }

          const subsSnapshot = await fetchSubsHandleRecord(
            SPACES_API_BASE_URL,
            spaceName,
            subspace
          );
          const spaceRow = mySpaces.find(
            (s) => s.subspace === subspace && s.spaceName === spaceNameLower
          );
          const tenantQuote =
            spaceRow?.chainPresence !== 'on-chain'
              ? await fetchTenantQuoteRecord(SPACES_API_BASE_URL, spaceName, subspace)
              : null;
          let pipelineBatchConfirming: boolean | null = null;
          if (subsSnapshot?.subsStatus === 'committed') {
            pipelineBatchConfirming = await fetchSpacePipelineBatchConfirming(
              SPACES_API_BASE_URL,
              spaceName
            );
          }
          if (subsSnapshot?.subsStatus) {
            unifiedStatus = mergeStatusWithSubsHandle(
              unifiedStatus,
              subsSnapshot.subsStatus
            ) as UnifiedStatus | null;
            if (subsSnapshot.subsStatus === 'staged') {
              console.log(
                `[Spaces] subs handle staged → payment confirmed for ${subspace}@${spaceName}`
              );
            }
            if (subsSnapshot.subsStatus === 'committed') {
              console.log(
                `[Spaces] subs handle committed for ${subspace}@${spaceName}`
              );
            }
          }

          // Use unified status if available, otherwise map from job status
          if (unifiedStatus) {
            updateSpaceStatus(unifiedStatus, subsSnapshot, tenantQuote, pipelineBatchConfirming);
            if (
              unifiedStatusPurchaseType !== 'pointer' &&
              !subsPaymentConfirmToastShown &&
              subsSnapshot?.subsStatus === 'staged' &&
              unifiedStatus === 'confirmed'
            ) {
              subsPaymentConfirmToastShown = true;
              toast.success('Payment confirmed on-chain');
            }
            if (unifiedStatusPurchaseType === 'pointer') {
              const pointerTerminal: UnifiedStatus[] = [
                'certificate_delivered',
                'sptr_delivered',
                'expired',
                'cancelled',
              ];
              if (
                !pointerPaymentConfirmToastShown &&
                paymentConfirmedOrLater.has(unifiedStatus) &&
                !pointerTerminal.includes(unifiedStatus)
              ) {
                pointerPaymentConfirmToastShown = true;
                toast.success('Payment confirmed on-chain');
              }
            }
          } else {
            const job = data.job;
            // Map job status to unified status
            const statusMap: Record<string, UnifiedStatus> = {
              pending_payment: 'pending_payment',
              processing: 'processing',
              confirmed: 'confirmed',
              expired: 'expired',
              cancelled: 'cancelled',
            };
            let mappedStatus = statusMap[job.status] || 'pending_payment';
            const mergedFromSubs = mergeStatusWithSubsHandle(
              mappedStatus,
              subsSnapshot?.subsStatus
            );
            if (mergedFromSubs) {
              mappedStatus = mergedFromSubs as UnifiedStatus;
            }
            updateSpaceStatus(mappedStatus, subsSnapshot, tenantQuote, pipelineBatchConfirming);
            if (
              !subsPaymentConfirmToastShown &&
              subsSnapshot?.subsStatus === 'staged' &&
              mappedStatus === 'confirmed'
            ) {
              subsPaymentConfirmToastShown = true;
              toast.success('Payment confirmed on-chain');
            }
            unifiedStatus = mappedStatus;
          }

          const scriptPubKeyHex =
            subsSnapshot?.scriptPubkeyHex?.trim() || spaceRow?.scriptPubKeyHex?.trim();
          if (scriptPubKeyHex) {
            const listnumsSnapshot = await fetchListnumsChainSnapshot(
              SPACES_API_BASE_URL,
              scriptPubKeyHex
            );
            if (listnumsSnapshot?.onChain) {
              markSpaceOnChainFromListnums(listnumsSnapshot);
              updatePollingState(Date.now(), false);
              console.log(
                `[Spaces] ${subspace}@${spaceNameLower} is on-chain — stopping status poll for job ${jobId}`
              );
              return data;
            }
          } else if (spaceRow?.chainPresence === 'on-chain') {
            updatePollingState(Date.now(), false);
            console.log(
              `[Spaces] ${subspace}@${spaceNameLower} is on-chain — stopping status poll for job ${jobId}`
            );
            return data;
          }

          // Check for terminal states
          const terminalStates: UnifiedStatus[] = [
            'certificate_delivered',
            'sptr_delivered',
            'expired',
            'cancelled',
          ];
          const currentStatus =
            unifiedStatus || (data.purchase?.unified_status as UnifiedStatus) || 'pending_payment';

          if (terminalStates.includes(currentStatus)) {
            updatePollingState(nextCheckTime, false);
            console.log(`[Spaces] Job ${jobId} completed with status: ${currentStatus}`);
            if (currentStatus === 'certificate_delivered' || currentStatus === 'sptr_delivered') {
              toast.success(`Purchase complete for ${subspace}@${spaceName}`);
            } else if (currentStatus === 'expired') {
              toast.error(`Purchase expired for ${subspace}@${spaceName}`);
            } else if (currentStatus === 'cancelled') {
              toast.info(`Purchase cancelled for ${subspace}@${spaceName}`);
            }
            return data;
          }

          // Check expiration
          const job = data.job;
          if (job && job.is_expired) {
            updateSpaceStatus('expired');
            updatePollingState(nextCheckTime, false);
            toast.error(`Purchase expired for ${subspace}@${spaceName}`);
            return { ...data, expired: true };
          }

          if (job) {
            console.log(`[Spaces] Job ${jobId}: ${job.status} (attempt ${attempt + 1})`);
            if (job.blocks_until_expiration !== null) {
              console.log(`  Blocks until expiration: ${job.blocks_until_expiration}`);
            }
          }
          if (unifiedStatus) {
            console.log(`[Spaces] Unified status: ${unifiedStatus} (attempt ${attempt + 1})`);
          }

          // Exponential backoff: double delay, up to maxDelay
          delay = Math.min(delay * 2, maxDelay);
          attempt++;

          // Set next check time for the next poll (after exponential backoff)
          const nextCheckTimeAfterDelay = Date.now() + delay;
          updatePollingState(nextCheckTimeAfterDelay, true);

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, delay));
        } catch (error) {
          console.error(`[Spaces] Polling error (attempt ${attempt + 1}):`, error);
          const nextCheckTime = Date.now() + delay;
          updatePollingState(nextCheckTime, true);

          // On error, wait before retrying (with exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, maxDelay);
          attempt++;

          // If max attempts reached, stop polling
          if (attempt >= maxAttempts) {
            updatePollingState(nextCheckTime, false);
            toast.error(`Max polling attempts reached for ${subspace}@${spaceName}`);
            return null;
          }
        }
      }

      updatePollingState(Date.now(), false);
      toast.error(`Max polling attempts (${maxAttempts}) reached for ${subspace}@${spaceName}`);
      return null;
    } finally {
      activePurchaseJobPolls.delete(jobId);
    }
  };

  const pollJobStatusRef = useRef(pollJobStatus);
  pollJobStatusRef.current = pollJobStatus;
  useEffect(() => {
    return registerPurchaseStatusPollStarter((p) => {
      void pollJobStatusRef.current(p.jobId, p.spaceName, p.subspace, {
        unifiedStatusPurchaseType: p.unifiedStatusPurchaseType,
      });
    });
  }, []);

  const handleSimulate = async () => {
    console.log('[Spaces] Simulate transaction:', txHex);
    console.log('[Spaces] Current jobId:', currentJobId);
    console.log('[Spaces] Current jobData:', currentJobData);

    setShowTxHexModal(false);

    if (!currentJobId || !currentJobData) {
      console.warn('[Spaces] Cannot simulate: missing jobId or jobData', {
        currentJobId,
        currentJobData,
      });
      toast.error('Cannot simulate: purchase job not ready. Complete the purchase flow first.');
      return;
    }

    const { handle, subspace: currentSubspace, spaceName: currentSpaceName } = currentJobData;
    const spaceNameLower = currentSpaceName.toLowerCase();
    const simulatedTxid = buildSimulatedTransactionId(currentJobId);

    console.log('[Spaces] Simulated payment txid:', simulatedTxid);

    const spaceEntry = mySpaces.find(
      (s) => s.subspace === currentSubspace && s.spaceName === spaceNameLower
    );
    const pendingPurchaseId =
      spaceEntry?.purchaseId ??
      (pendingPaymentCallbackRef.current?.jobId === currentJobId
        ? pendingPaymentCallbackRef.current.purchaseId
        : undefined);
    const scriptPubKeyHex =
      purchaseTaprootPathRef.current?.scriptPubKeyHex?.trim() ??
      spaceEntry?.scriptPubKeyHex?.trim();

    let registration: { purchaseId?: number; watchOk: boolean; callbackOk: boolean };
    try {
      registration = await registerPurchasePaymentOnServer({
        baseUrl: SPACES_API_BASE_URL,
        transactionId: simulatedTxid,
        jobId: currentJobId,
        spaceNameLower,
        subspaceTrimmed: currentSubspace,
        handle,
        paymentWatch: postPurchaseWatchRef.current,
        pendingPurchaseId,
        scriptPubKeyHex,
        logLabel: 'simulate',
      });
    } catch (error) {
      console.error('[Spaces] Simulated payment registration failed:', error);
      toast.error('Failed to register simulated payment with the server.');
      return;
    }

    const { purchaseId, watchOk, callbackOk } = registration;
    console.log('[Spaces] Simulated payment registration:', {
      purchaseId,
      watchOk,
      callbackOk,
      simulatedTxid,
    });

    const newSpace = {
      subspace: currentSubspace,
      spaceName: spaceNameLower,
      handle,
      status: 'processing' as UnifiedStatus,
      jobId: currentJobId,
      ...(purchaseId != null ? { purchaseId } : {}),
      ...(scriptPubKeyHex ? { scriptPubKeyHex } : {}),
      ...(purchaseTaprootPathRef.current?.fullPath
        ? { taprootDerivationPath: purchaseTaprootPathRef.current.fullPath }
        : {}),
    };

    setMySpaces((prev) => {
      const existingIndex = prev.findIndex(
        (s) => s.subspace === newSpace.subspace && s.spaceName === newSpace.spaceName
      );
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = { ...updated[existingIndex], ...newSpace };
        return updated;
      }
      return [...prev, newSpace];
    });

    pollJobStatus(currentJobId, spaceNameLower, currentSubspace).catch((error) => {
      console.error('[Spaces] Polling failed:', error);
    });

    if (watchOk && callbackOk) {
      toast.success(`Simulation started (${simulatedTxid.slice(0, 16)}…)`);
    } else if (watchOk || callbackOk) {
      toast.info('Simulation partially registered — monitoring job status');
    } else {
      toast.error('Could not register simulated payment. Polling job status anyway.');
    }
  };

  const handleBroadcast = async () => {
    if (!txHexData) {
      Alert.alert('Error', 'Transaction data not available');
      return;
    }

    try {
      setButtonState('loading');
      setIsButtonEnabled(false);
      setButtonLabel('Broadcasting...');

      let txHash: string;

      if (txHexData.scriptType === 'P2TR' && txHexData.memo) {
        // P2TR transaction with memo
        txHash = await WDKService.sendByNetworkWithMemo(
          txHexData.network,
          txHexData.accountIndex,
          txHexData.amount / 100000000, // Convert to BTC
          txHexData.recipientAddress,
          txHexData.asset,
          txHexData.memo
        );
      } else {
        // P2WPKH transaction without memo
        txHash = await WDKService.sendByNetwork(
          txHexData.network,
          txHexData.accountIndex,
          txHexData.amount / 100000000, // Convert to BTC
          txHexData.recipientAddress,
          txHexData.asset
        );
      }

      console.log('[Spaces] Transaction broadcasted successfully:', txHash);
      const hashStr = typeof txHash === 'object' && txHash !== null ? (txHash as any).hash ?? JSON.stringify(txHash) : String(txHash);
      toast.success(`Transaction broadcasted! Hash: ${hashStr.substring(0, 16)}...`);

      const currentSpaceNameLower = spaceName.toLowerCase();
      const currentSubspaceTrimmed = subspace.trim();
      const broadcastHandle =
        purchaseData?.handle ??
        currentJobData?.handle ??
        `${currentSubspaceTrimmed}@${currentSpaceNameLower}`;

      let purchaseIdFromRegistration: number | undefined;
      const spaceEntryForPayment = mySpaces.find(
        (s) => s.subspace === currentSubspaceTrimmed && s.spaceName === currentSpaceNameLower
      );
      const scriptPubKeyHex =
        purchaseTaprootPathRef.current?.scriptPubKeyHex?.trim() ??
        spaceEntryForPayment?.scriptPubKeyHex?.trim();

      if (hashStr && currentJobId != null) {
        const pendingPurchaseId =
          spaceEntryForPayment?.purchaseId ??
          (pendingPaymentCallbackRef.current?.jobId === currentJobId
            ? pendingPaymentCallbackRef.current.purchaseId
            : undefined);

        const registration = await registerPurchasePaymentOnServer({
          baseUrl: SPACES_API_BASE_URL,
          transactionId: hashStr,
          jobId: currentJobId,
          spaceNameLower: currentSpaceNameLower,
          subspaceTrimmed: currentSubspaceTrimmed,
          handle: broadcastHandle,
          paymentWatch: postPurchaseWatchRef.current,
          pendingPurchaseId,
          scriptPubKeyHex,
          logLabel: 'broadcast',
        });

        purchaseIdFromRegistration = registration.purchaseId;

        if (!registration.watchOk) {
          toast.error('Could not register payment for watching. Polling may still work.');
        }
        if (registration.watchOk && !registration.callbackOk && registration.purchaseId != null) {
          toast.error('Payment was broadcast but the server could not be notified. Polling will continue.');
        } else if (!registration.watchOk && !registration.callbackOk && registration.purchaseId == null) {
          console.warn(
            '[Spaces] Skipping /api/payments/callback: missing purchase_id (mySpaces/AsyncStorage) or transaction id',
            { purchaseId: registration.purchaseId, hasHash: !!hashStr }
          );
        }
      }

      // Add subspace to My Spaces and start polling if we have jobId
      if (currentJobId && (purchaseData || currentJobData)) {
        const currentSpaceName = spaceName.toLowerCase();
        const currentSubspace = subspace.trim();
        const newSpace = {
          subspace: currentSubspace,
          spaceName: currentSpaceName,
          handle: broadcastHandle,
          status: 'processing' as const,
          jobId: currentJobId,
          ...(purchaseIdFromRegistration != null ? { purchaseId: purchaseIdFromRegistration } : {}),
          ...(scriptPubKeyHex ? { scriptPubKeyHex } : {}),
          ...(purchaseTaprootPathRef.current?.fullPath
            ? { taprootDerivationPath: purchaseTaprootPathRef.current.fullPath }
            : {}),
        };

        setMySpaces((prev) => {
          const existingIndex = prev.findIndex(
            (s) => s.subspace === newSpace.subspace && s.spaceName === newSpace.spaceName
          );
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = {
              ...updated[existingIndex],
              jobId: currentJobId,
              status: 'processing',
              ...(purchaseIdFromRegistration != null
                ? { purchaseId: purchaseIdFromRegistration }
                : {}),
              ...(scriptPubKeyHex ? { scriptPubKeyHex } : {}),
              ...(purchaseTaprootPathRef.current?.fullPath
                ? { taprootDerivationPath: purchaseTaprootPathRef.current.fullPath }
                : {}),
            };
            return updated;
          }
          return [...prev, newSpace];
        });

        pollJobStatus(currentJobId, currentSpaceName, currentSubspace).catch((error) => {
          console.error('[Spaces] Polling failed:', error);
        });
      }

      finishPurchaseTxFlow();
    } catch (error) {
      console.error('[Spaces] Failed to broadcast transaction:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to broadcast transaction';
      Alert.alert('Broadcast Failed', errorMessage);
      setButtonState('available');
      setIsButtonEnabled(true);
    }
  };

  const handlePurchase = async () => {
    console.log('[Spaces] Purchase button pressed', {
      subspace,
      spaceName,
      quoteId,
      handle,
      priceSats,
      selectedDuration,
    });

    // If already in confirmation mode, handle sending the transaction
    if (isConfirmationMode) {
      if (!purchaseData || !quoteId) {
        console.error('[Spaces] Missing purchase data or quoteId');
        Alert.alert('Error', 'Missing purchase information. Please try again.');
        return;
      }

      // Free coupon path: skip transaction composition entirely
      if (completelyFree) {
        setButtonState('loading');
        setIsButtonEnabled(false);
        setButtonLabel('Requesting...');

        try {
          const currentSubspace = subspace.trim();
          const currentSpaceName = spaceName.toLowerCase();

          // Add to My Spaces
          const newSpace = {
            subspace: currentSubspace,
            spaceName: currentSpaceName,
            handle: purchaseData.handle,
            status: 'requesting' as const,
          };
          setMySpaces((prev) => {
            const existingIndex = prev.findIndex(
              (s) => s.subspace === newSpace.subspace && s.spaceName === newSpace.spaceName
            );
            if (existingIndex >= 0) {
              const updated = [...prev];
              updated[existingIndex] = newSpace;
              return updated;
            }
            return [...prev, newSpace];
          });

          // PUT to confirm purchase
          const url = `${SPACES_API_BASE_URL}/spaces/${currentSpaceName}/${currentSubspace}?app=${SPACES_APP_NAME}&format=json`;
          console.log(`[Spaces API] PUT ${url} (free coupon)`);

          const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quote_id: quoteId, purchase_type: PURCHASE_TYPE_SUBNAME }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Spaces API] PUT ${url} - HTTP error! status: ${response.status}`, errorText);
            throwSpacesApiHttpError(response.status, errorText);
          }

          const data = await response.json();
          console.log(`[Spaces API] PUT ${url} - Success (free coupon)`, data);

            if (data.job_id) {
              const d = data as Record<string, unknown>;
              const { pointerJobId, pointerPurchaseId } = pointerIdsFromPurchaseResponse(d);
              const resolvedPurchaseIdFree = purchaseIdFromRecord(d);
              setCurrentJobId(data.job_id);
              setCurrentJobData({
                handle: data.handle || purchaseData.handle,
                subspace: currentSubspace,
                spaceName: currentSpaceName,
              });

              setMySpaces((prev) =>
                prev.map((space) =>
                  space.subspace === currentSubspace && space.spaceName === currentSpaceName
                    ? {
                        ...space,
                        jobId: data.job_id,
                        purchaseId: resolvedPurchaseIdFree,
                        sptrJobId: pointerJobId,
                        sptrPurchaseId: pointerPurchaseId,
                        hasSptr: pointerJobId != null && pointerJobId > 0,
                        status: 'pending_payment' as UnifiedStatus,
                      }
                    : space
                )
              );

              if (data.handle) {
                const storageKey = `spaces_purchase_${data.job_id}`;
                const storageData = {
                  job_id: data.job_id,
                  handle: data.handle,
                  quote_id: data.quote_id,
                  purchase_id: resolvedPurchaseIdFree ?? data.purchase_id,
                  sptr_job_id: pointerJobId,
                  sptr_purchase_id: pointerPurchaseId,
                  has_sptr: pointerJobId != null && pointerJobId > 0,
                  timestamp: Date.now(),
                };
              await AsyncStorage.setItem(storageKey, JSON.stringify(storageData));
              console.log('[Spaces] Stored purchase data:', storageKey);
            }

            pollJobStatus(data.job_id, currentSpaceName, currentSubspace).catch((error) => {
              console.error('[Spaces] Polling failed:', error);
            });
          }

          // Dismiss confirmation
          setIsConfirmationMode(false);
          setPurchaseData(null);
          setButtonState('available');
          setIsButtonEnabled(true);

          if (priceSats !== null) {
            const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48);
            if (blockFee !== null) {
              setButtonLabel(calculateTotalPrice(priceSats, blockFee1, blockFee6, blockFee48, selectedDuration, btcPriceUSD, takeOnchain, sptrPrice, sptrFee1, sptrFee6, sptrFee48));
            }
          }

          toast.success(`Requested ${purchaseData.handle} for free!`);
        } catch (error) {
          console.error('[Spaces] Free coupon request failed:', error);
          if (error instanceof SpacesApiHttpError && error.refreshQuote) {
            handleSpacesPurchaseApiErrorRef.current(
              error,
              '[Spaces] Free coupon PUT failed (stale quote):'
            );
          } else {
            Alert.alert(
              'Error',
              error instanceof SpacesApiHttpError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : 'Failed to process request'
            );
            setButtonState('available');
            setIsButtonEnabled(true);
          }
        }
        return;
      }

      setButtonState('loading');
      setIsButtonEnabled(false);
      setButtonLabel('Composing Transaction...');

      const paymentAmountSats = resolvePurchasePaymentAmountSats({
        serverTotalPrice: purchaseData.total_price,
        priceSats,
        discountPercent,
        completelyFree,
        selectedDuration,
        blockFee1,
        blockFee6,
        blockFee48,
        takeOnchain,
        sptrPrice,
        sptrFee1,
        sptrFee6,
        sptrFee48,
      });

      try {
        // Get Bitcoin account through WDKService
        if (!wallet) {
          throw new Error('Wallet not available');
        }

        // Get the Bitcoin address from addresses (same as settings page)
        // This is the address that should be used for transactions
        // The settings page uses accountIndex=0 via resolveWalletAddresses()
        const bitcoinAddress = addresses?.[NetworkType.SEGWIT];
        if (!bitcoinAddress) {
          throw new Error('Bitcoin address not available. Please ensure wallet is initialized.');
        }

        // Detect script type dynamically from the wallet address
        // P2TR (Taproot) addresses start with bc1p (mainnet) or tb1p (testnet)
        // P2WPKH (Native SegWit) addresses start with bc1q (mainnet) or tb1q (testnet)
        // P2PKH addresses start with 1 (mainnet) or m/n (testnet)
        let scriptType: 'P2TR' | 'P2WPKH' | 'P2PKH';
        const addressLower = bitcoinAddress.toLowerCase();
        if (addressLower.startsWith('bc1p') || addressLower.startsWith('tb1p')) {
          scriptType = 'P2TR';
        } else if (addressLower.startsWith('bc1q') || addressLower.startsWith('tb1q')) {
          scriptType = 'P2WPKH';
        } else if (
          addressLower.startsWith('1') ||
          addressLower.startsWith('m') ||
          addressLower.startsWith('n')
        ) {
          scriptType = 'P2PKH';
        } else {
          // Fallback to config if address format is unrecognized
          const chainsConfig = getChainsConfig();
          const bitcoinConfig = chainsConfig.bitcoin;
          scriptType = (bitcoinConfig?.script_type as 'P2TR' | 'P2WPKH' | 'P2PKH') || 'P2WPKH';
        }

        console.log('[Spaces] Script type detected from address:', scriptType);
        console.log('[Spaces] Bitcoin address:', bitcoinAddress);
        console.log('[Spaces] Composing transaction:', {
          to: purchaseData.taproot_address,
          value: paymentAmountSats,
          originalTotalPrice: purchaseData.total_price,
          couponDiscountPercent: discountPercent,
          scriptType,
        });

        // Debug: Log account info to help diagnose UTXO issues
        // The error "No unspent outputs available" means the account at index 0
        // doesn't have UTXOs, or there's a network/Electrum server mismatch
        console.log('[Spaces] Using account index 0 for transaction');
        console.log('[Spaces] Network: SEGWIT (Bitcoin)');
        console.log(
          '[Spaces] Using Bitcoin address from addresses[NetworkType.SEGWIT]:',
          bitcoinAddress
        );
        console.log(
          '[Spaces] Using account index 0 (same as settings page via resolveWalletAddresses)'
        );

        // Use the appropriate method based on script_type:
        // - P2TR (Taproot): Use quoteSendByNetworkWithMemoTX (requires memo)
        // - P2WPKH (Native SegWit): Use quoteSendByNetworkTX (no memo required)
        // We use account index 0, which matches what resolveWalletAddresses() uses
        // This ensures we're using the same address that's displayed on the settings page
        // Pass amount in satoshis directly (WDKService will handle conversion internally)
        // Note: Both methods use confirmationTarget: 1 by default.
        // TODO: Update WDKService to accept conf_target parameter and use getConfTarget(selectedDuration)
        // to match the user's selected duration.
        let transactionHex: string;

        if (scriptType === 'P2TR') {
          // P2TR (Taproot) - use memo method
          // WDKService expects amount in BTC; total_price is in sats
          const quoteOptions = {
            network: NetworkType.SEGWIT,
            accountIndex: 0,
            amount: paymentAmountSats / 100000000,
            recipientAddress: purchaseData.taproot_address,
            asset: AssetTicker.BTC,
            memo: purchaseData.handle,
          };
          console.log(
            '[Spaces] quoteSendByNetworkWithMemoTX options:',
            JSON.stringify(quoteOptions, null, 2)
          );

          // Check balance before attempting transaction (including fees)
          const btcBalance = balances?.list?.find(
            (b) => b.networkType === NetworkType.SEGWIT && b.denomination === AssetTicker.BTC
          );
          // Convert balance from BTC to satoshis (balance.value is in BTC, multiply by 100M)
          const balanceBTC = btcBalance ? parseFloat(btcBalance.value) : 0;
          const balanceSats = balanceBTC * 100000000;

          // Estimate transaction fee to check if we have enough balance
          const requestedSats = paymentAmountSats;
          let quotedFeeSats: number | null = null;
          try {
            const feeQuote = await WDKService.quoteSendByNetworkWithMemo(
              quoteOptions.network,
              quoteOptions.accountIndex,
              quoteOptions.amount,
              quoteOptions.recipientAddress,
              quoteOptions.asset,
              quoteOptions.memo
            );
            quotedFeeSats = Math.round(feeQuote * 100000000);
          } catch (feeError) {
            console.warn(
              '[Spaces] Fee quote failed; using conservative Taproot memo estimate:',
              feeError
            );
          }

          const { estimatedFeeSats, totalRequiredSats, feeSource } =
            resolveTaprootPurchaseRequiredSats(
              requestedSats,
              purchaseData.handle,
              quotedFeeSats
            );

          console.log('[Spaces] Balance check (P2TR):', {
            balanceBTC: balanceBTC.toFixed(8),
            balanceSats: Math.round(balanceSats),
            requestedAmountSats: requestedSats,
            requestedAmountBTC: quoteOptions.amount.toFixed(8),
            estimatedFeeSats,
            feeSource,
            totalRequiredSats,
            sufficient: balanceSats >= totalRequiredSats,
          });

          if (balanceSats < totalRequiredSats) {
            const shortfall = totalRequiredSats - balanceSats;
            console.error('[Spaces] Insufficient balance (including fees) - P2TR:', {
              balanceSats: Math.round(balanceSats),
              requestedSats,
              estimatedFeeSats,
              totalRequiredSats,
              shortfall,
            });
            throw new Error(
              `Insufficient balance. Have ${Math.round(balanceSats)} sats, need ${totalRequiredSats} sats (${requestedSats} amount + ${estimatedFeeSats} fee, shortfall: ${shortfall} sats)`
            );
          }

          transactionHex = await WDKService.quoteSendByNetworkWithMemoTX(
            quoteOptions.network,
            quoteOptions.accountIndex,
            quoteOptions.amount,
            quoteOptions.recipientAddress,
            quoteOptions.asset,
            quoteOptions.memo
          );
        } else {
          // P2WPKH (Native SegWit) - use non-memo method
          // WDKService expects amount in BTC; total_price is in sats
          const quoteOptions = {
            network: NetworkType.SEGWIT,
            accountIndex: 0,
            amount: paymentAmountSats / 100000000,
            recipientAddress: purchaseData.taproot_address,
            asset: AssetTicker.BTC,
          };
          console.log(
            '[Spaces] quoteSendByNetworkTX options:',
            JSON.stringify(quoteOptions, null, 2)
          );

          // Check balance before attempting transaction (including fees)
          const btcBalance = balances?.list?.find(
            (b) => b.networkType === NetworkType.SEGWIT && b.denomination === AssetTicker.BTC
          );
          // Convert balance from BTC to satoshis (balance.value is in BTC, multiply by 100M)
          const balanceBTC = btcBalance ? parseFloat(btcBalance.value) : 0;
          const balanceSats = balanceBTC * 100000000;

          // Estimate transaction fee to check if we have enough balance
          let estimatedFeeSats = 0;
          let totalRequiredSats = paymentAmountSats;
          try {
            const feeQuote = await WDKService.quoteSendByNetwork(
              quoteOptions.network,
              quoteOptions.accountIndex,
              quoteOptions.amount,
              quoteOptions.recipientAddress,
              quoteOptions.asset
            );
            estimatedFeeSats = Math.round(feeQuote * 100000000);
            totalRequiredSats = paymentAmountSats + estimatedFeeSats;
          } catch (feeError) {
            console.warn('[Spaces] Could not estimate fee, using amount only:', feeError);
          }

          console.log('[Spaces] Balance check:', {
            balanceBTC: balanceBTC.toFixed(8),
            balanceSats: Math.round(balanceSats),
            requestedAmountSats: paymentAmountSats,
            requestedAmountBTC: quoteOptions.amount.toFixed(8),
            estimatedFeeSats,
            totalRequiredSats,
            sufficient: balanceSats >= totalRequiredSats,
          });

          if (balanceSats < totalRequiredSats) {
            const shortfall = totalRequiredSats - balanceSats;
            console.error('[Spaces] Insufficient balance (including fees):', {
              balanceBTC: balanceBTC.toFixed(8),
              balanceSats: Math.round(balanceSats),
              requestedAmountSats: paymentAmountSats,
              estimatedFeeSats,
              totalRequiredSats,
              shortfall: Math.round(shortfall),
            });
            throw new Error(
              `Insufficient balance. Have ${Math.round(balanceSats)} sats, need ${totalRequiredSats} sats (${paymentAmountSats} amount + ${estimatedFeeSats} fee, shortfall: ${shortfall} sats)`
            );
          }

          transactionHex = await WDKService.quoteSendByNetworkTX(
            quoteOptions.network,
            quoteOptions.accountIndex,
            quoteOptions.amount,
            quoteOptions.recipientAddress,
            quoteOptions.asset
          );
        }

        // Log full transaction hex for verification
        console.log('[Spaces] Full transaction hex:', transactionHex);
        console.log('[Spaces] Transaction hex length:', transactionHex.length);
        console.log('[Spaces] Transaction hex generated:', transactionHex.substring(0, 50) + '...');

        // Store transaction data for broadcasting
        if (scriptType === 'P2TR') {
          setTxHexData({
            scriptType: 'P2TR',
            network: NetworkType.SEGWIT,
            accountIndex: 0,
            amount: paymentAmountSats,
            recipientAddress: purchaseData.taproot_address,
            asset: AssetTicker.BTC,
            memo: purchaseData.handle,
          });
        } else {
          setTxHexData({
            scriptType: 'P2WPKH',
            network: NetworkType.SEGWIT,
            accountIndex: 0,
            amount: paymentAmountSats,
            recipientAddress: purchaseData.taproot_address,
            asset: AssetTicker.BTC,
          });
        }

        // Add subspace to My Spaces list with "purchasing" status
        const subspaceTrimmed = subspace.trim();
        const spaceNameLower = spaceName.toLowerCase();
        const priorRowForPath = mySpaces.find(
          (s) => s.subspace === subspaceTrimmed && s.spaceName === spaceNameLower
        );
        const needsTaprootPath = !priorRowForPath?.scriptPubKeyHex?.trim();

        const newSpace = {
          subspace: subspaceTrimmed,
          spaceName: spaceNameLower,
          handle: purchaseData.handle,
          status: 'purchasing' as const,
        };
        setMySpaces((prev) => {
          // Check if this subspace already exists, if so update it, otherwise add it
          const existingIndex = prev.findIndex(
            (s) => s.subspace === newSpace.subspace && s.spaceName === newSpace.spaceName
          );
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = newSpace;
            return updated;
          }
          return [...prev, newSpace];
        });

        // Register the purchase with the server before showing the broadcast modal so job_id / purchase_id exist
        // (otherwise the user could broadcast while the PUT is still in flight and the payment callback would lack purchase_id).
        const url = `${SPACES_API_BASE_URL}/spaces/${spaceNameLower}/${subspaceTrimmed}?app=${SPACES_APP_NAME}&format=json`;
        const startTime = Date.now();
        console.log(`[Spaces API] PUT ${url}`);

        const requestBody = {
          quote_id: quoteId,
          purchase_type: PURCHASE_TYPE_SUBNAME,
        };

        console.log('[Spaces API] PUT request body:', JSON.stringify(requestBody, null, 2));

        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        const endTime = Date.now();
        const duration = endTime - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `[Spaces API] PUT ${url} - HTTP error! status: ${response.status} (${duration}ms)`,
            errorText
          );
          throwSpacesApiHttpError(response.status, errorText);
        }

        const data = await response.json();
        console.log(`[Spaces API] PUT ${url} - Success (${duration}ms)`, data);

        const dataRec = data as Record<string, unknown>;
        const { pointerJobId, pointerPurchaseId } = pointerIdsFromPurchaseResponse(dataRec);

        // Store job_id and related data for polling
        if (data.job_id) {
          setCurrentJobId(data.job_id);
          setCurrentJobData({
            handle: data.handle || purchaseData.handle,
            subspace: subspace.trim(),
            spaceName: spaceName.toLowerCase(),
          });
          console.log(
            '[Spaces] Job ID received:',
            data.job_id,
            'with handle:',
            data.handle || purchaseData.handle
          );
        }

        const resolvedPurchaseIdPut = purchaseIdFromRecord(dataRec);

        // Update space entry with job IDs and purchase IDs
        setMySpaces((prev) =>
          prev.map((space) =>
            space.subspace === subspace.trim() && space.spaceName === spaceNameLower
              ? {
                  ...space,
                  jobId: data.job_id,
                  purchaseId: resolvedPurchaseIdPut,
                  sptrJobId: pointerJobId,
                  sptrPurchaseId: pointerPurchaseId,
                  hasSptr: pointerJobId != null && pointerJobId > 0,
                  status: 'pending_payment' as UnifiedStatus,
                }
              : space
          )
        );

        const parsedPurchaseId = resolvedPurchaseIdPut ?? NaN;
        const parsedJobId =
          typeof data.job_id === 'number'
            ? data.job_id
            : data.job_id != null
              ? Number(data.job_id)
              : NaN;
        if (Number.isFinite(parsedPurchaseId) && Number.isFinite(parsedJobId)) {
          pendingPaymentCallbackRef.current = {
            jobId: parsedJobId,
            purchaseId: parsedPurchaseId,
          };
        } else {
          pendingPaymentCallbackRef.current = null;
        }

        // Store job_id and handle in local storage
        if (data.job_id && data.handle) {
          const storageKey = `spaces_purchase_${data.job_id}`;
          const storageData = {
            job_id: data.job_id,
            handle: data.handle,
            quote_id: data.quote_id,
            purchase_id: resolvedPurchaseIdPut ?? data.purchase_id,
            sptr_job_id: pointerJobId,
            sptr_purchase_id: pointerPurchaseId,
            has_sptr: pointerJobId != null && pointerJobId > 0,
            timestamp: Date.now(),
          };
          await AsyncStorage.setItem(storageKey, JSON.stringify(storageData));
          console.log('[Spaces] Stored purchase data in AsyncStorage:', storageKey, storageData);
        } else if (data.job_id != null && Number.isFinite(parsedPurchaseId)) {
          const storageKey = `spaces_purchase_${data.job_id}`;
          await AsyncStorage.setItem(
            storageKey,
            JSON.stringify({
              job_id: data.job_id,
              purchase_id: parsedPurchaseId,
              timestamp: Date.now(),
            })
          );
          console.log('[Spaces] Stored minimal purchase id in AsyncStorage:', storageKey);
        }

        if (needsTaprootPath) {
          const reserved = mySpaces
            .filter(
              (s) => !(s.subspace === subspaceTrimmed && s.spaceName === spaceNameLower)
            )
            .map((s) => s.scriptPubKeyHex)
            .filter((spk): spk is string => Boolean(spk?.trim()));

          console.log('[Spaces] Resolving next available Taproot path for first-time purchase…');
          const nextPath = await resolveNextAvailableTaprootPath({
            baseUrl: SPACES_API_BASE_URL,
            reservedScriptPubKeys: reserved,
          });

          if (!nextPath) {
            console.error('[Spaces] No available Taproot path for first-time purchase');
            toast.error(
              'Could not reserve a wallet path for this handle. Use Find Spaces or try again.'
            );
            setButtonState('available');
            setIsButtonEnabled(true);
            setIsConfirmationMode(false);
            setPurchaseData(null);
            postPurchaseWatchRef.current = null;
            purchaseTaprootPathRef.current = null;
            pendingPaymentCallbackRef.current = null;
            return;
          }

          console.log('[Spaces] Reserved Taproot path for purchase:', {
            fullPath: nextPath.fullPath,
            scriptPubKeyHex: `${nextPath.scriptPubKeyHex.slice(0, 16)}…`,
            address: nextPath.address,
          });

          purchaseTaprootPathRef.current = nextPath;

          setMySpaces((prev) =>
            prev.map((space) =>
              space.subspace === subspaceTrimmed && space.spaceName === spaceNameLower
                ? {
                    ...space,
                    scriptPubKeyHex: nextPath.scriptPubKeyHex,
                    taprootDerivationPath: nextPath.fullPath,
                    chainPresence: 'off-chain' as const,
                  }
                : space
            )
          );

          if (data.job_id) {
            const storageKey = `spaces_purchase_${data.job_id}`;
            try {
              const existingRaw = await AsyncStorage.getItem(storageKey);
              const existing = existingRaw ? JSON.parse(existingRaw) : {};
              await AsyncStorage.setItem(
                storageKey,
                JSON.stringify({
                  ...existing,
                  script_pubkey: nextPath.scriptPubKeyHex,
                  taproot_derivation_path: nextPath.fullPath,
                  taproot_receive_address: nextPath.address,
                })
              );
            } catch (storageErr) {
              console.warn('[Spaces] Failed to persist taproot path on purchase blob:', storageErr);
            }
          }
        } else if (priorRowForPath?.scriptPubKeyHex?.trim()) {
          purchaseTaprootPathRef.current = {
            scriptPubKeyHex: priorRowForPath.scriptPubKeyHex.trim(),
            fullPath: priorRowForPath.taprootDerivationPath ?? '',
            relativePath: '',
            address: '',
          };
        }

        setTxHex(transactionHex);
        setShowTxHexModal(true);

        // Reset confirmation mode
        setIsConfirmationMode(false);
        setPurchaseData(null);
        setButtonState('available');
        setIsButtonEnabled(true);

        // Recalculate button label
        if (priceSats !== null) {
          const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48);
          if (blockFee !== null) {
            const totalLabel = calculateTotalPrice(
              priceSats,
              blockFee1,
              blockFee6,
              blockFee48,
              selectedDuration,
              btcPriceUSD,
              takeOnchain,
              sptrPrice,
              sptrFee1,
              sptrFee6,
              sptrFee48
            );
            setButtonLabel(totalLabel);
          }
        }
      } catch (error) {
        if (error instanceof SpacesApiHttpError && error.refreshQuote) {
          handleSpacesPurchaseApiErrorRef.current(
            error,
            '[Spaces] Confirmation flow failed (stale quote):'
          );
          return;
        }

        console.error('[Spaces] Error in confirmation flow:', error);

        // Enhanced error logging for insufficient balance
        if (error instanceof Error && error.message.includes('Insufficient balance')) {
          const btcBalance = balances?.list?.find(
            (b) => b.networkType === NetworkType.SEGWIT && b.denomination === AssetTicker.BTC
          );
          // Convert balance from BTC to satoshis (balance.value is in BTC, multiply by 100M)
          const balanceBTC = btcBalance ? parseFloat(btcBalance.value) : 0;
          const balanceSats = balanceBTC * 100000000;
          const requestedAmount = resolvePurchasePaymentAmountSats({
            serverTotalPrice: purchaseData?.total_price ?? 0,
            priceSats,
            discountPercent,
            completelyFree,
            selectedDuration,
            blockFee1,
            blockFee6,
            blockFee48,
            takeOnchain,
            sptrPrice,
            sptrFee1,
            sptrFee6,
            sptrFee48,
          });
          const { estimatedFeeSats, totalRequiredSats } = resolveTaprootPurchaseRequiredSats(
            requestedAmount,
            purchaseData?.handle ?? '',
            null
          );

          console.error('[Spaces] Insufficient balance details:', {
            errorMessage: error.message,
            balanceBTC: balanceBTC.toFixed(8),
            balanceSats: Math.round(balanceSats),
            requestedAmount,
            requestedAmountBTC: (requestedAmount / 100000000).toFixed(8),
            estimatedFeeSats,
            totalRequiredSats,
            shortfall: Math.round(totalRequiredSats - balanceSats),
            shortfallBTC: ((totalRequiredSats - balanceSats) / 100000000).toFixed(8),
            fromAddress: addresses?.[NetworkType.SEGWIT],
            recipientAddress: purchaseData?.taproot_address,
            memo: purchaseData?.handle,
          });
        } else {
          console.error('[Spaces] Transaction error details:', {
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            purchaseData,
            fromAddress: addresses?.[NetworkType.SEGWIT],
          });
        }

        Alert.alert(
          'Error',
          error instanceof SpacesApiHttpError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to process transaction'
        );
        setButtonState('available');
        setIsButtonEnabled(true);
        // Restore button label
        if (purchaseData) {
          const displayTotal = resolvePurchasePaymentAmountSats({
            serverTotalPrice: purchaseData.total_price,
            priceSats,
            discountPercent,
            completelyFree,
            selectedDuration,
            blockFee1,
            blockFee6,
            blockFee48,
            takeOnchain,
            sptrPrice,
            sptrFee1,
            sptrFee6,
            sptrFee48,
          });
          const formattedSats = displayTotal.toLocaleString();
          if (btcPriceUSD !== null) {
            const satsPerBitcoin = 100000000;
            const usdAmount = (displayTotal / satsPerBitcoin) * btcPriceUSD;
            const formattedUSD = usdAmount.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            setButtonLabel(
              `Send ${formattedSats} sats = $${formattedUSD} for ${purchaseData.handle}`
            );
          } else {
            setButtonLabel(`Send ${formattedSats} sats for ${purchaseData.handle}`);
          }
        }
      }
      return;
    }

    // Validate required data
    if (!priceSats) {
      console.error('[Spaces] Missing priceSats');
      Alert.alert('Error', 'Price information is missing. Please try again.');
      return;
    }

    if (!handle) {
      console.error('[Spaces] Missing handle');
      Alert.alert('Error', 'Handle information is missing. Please try again.');
      return;
    }

    if (quoteId === null) {
      console.error('[Spaces] Missing quoteId');
      Alert.alert('Error', 'Quote ID is missing. Please try again.');
      return;
    }

    const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48);
    if (blockFee === null) {
      console.error('[Spaces] Block fee not available for duration:', selectedDuration);
      Alert.alert('Error', 'Block fee not available. Please select a duration.');
      return;
    }

    setButtonState('loading');
    setIsButtonEnabled(false);
    setButtonLabel('Processing...');

    const spaceNameLower = spaceName.toLowerCase();
    const url = `${SPACES_API_BASE_URL}/spaces/${spaceNameLower}/${subspace.trim()}?app=${SPACES_APP_NAME}&format=json`;
    const startTime = Date.now();
    console.log(`[Spaces API] POST ${url}`);

    try {
      const confTarget = getConfTarget(selectedDuration);
      const sptrBlockFee = getSptrFee(selectedDuration, sptrFee1, sptrFee6, sptrFee48);
      const requestBody: Record<string, unknown> = {
        purchase_type: PURCHASE_TYPE_SUBNAME,
        block_fee: blockFee,
        handle: handle,
        price: priceSats,
        quote_id: quoteId,
        conf_target: confTarget,
      };
      if (takeOnchain && sptrPrice != null && sptrPrice > 0) {
        requestBody.include_pointer_purchase = true;
        requestBody.pointer_price = sptrPrice;
        requestBody.block_pointer_fee = sptrBlockFee;
      }
      if (couponStatus === 'valid' && couponCode.trim()) {
        requestBody.coupon_code = couponCode.trim().toUpperCase();
      }

      console.log('[Spaces API] POST request body:', JSON.stringify(requestBody, null, 2));

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[Spaces API] POST ${url} - HTTP error! status: ${response.status} (${duration}ms)`,
          errorText
        );
        throwSpacesApiHttpError(response.status, errorText);
      }

      const data = await response.json();
      console.log(`[Spaces API] POST ${url} - Success (${duration}ms)`, data);

      const dataRec = data as Record<string, unknown>;
      const { pointerJobId: pointerJobIdFromPost } = pointerIdsFromPurchaseResponse(dataRec);
      const postJobRaw = dataRec.job_id;
      const primaryJobIdParsed =
        typeof postJobRaw === 'number'
          ? postJobRaw
          : postJobRaw != null
            ? Number(postJobRaw)
            : NaN;
      const pw = dataRec.payment_watch;
      const ppw = dataRec.pointer_payment_watch;
      postPurchaseWatchRef.current = {
        primary:
          pw && typeof pw === 'object' && typeof (pw as PaymentWatchSpec).path === 'string'
            ? (pw as PaymentWatchSpec)
            : null,
        pointer:
          ppw && typeof ppw === 'object' && typeof (ppw as PaymentWatchSpec).path === 'string'
            ? (ppw as PaymentWatchSpec)
            : null,
        primaryJobId: Number.isFinite(primaryJobIdParsed) ? primaryJobIdParsed : null,
        pointerJobId: pointerJobIdFromPost ?? null,
      };

      // Store purchase data and enter confirmation mode
      setPurchaseData({
        taproot_address: data.taproot_address,
        handle: data.handle,
        total_price: data.total_price,
        expiring_blockheight: data.expiring_blockheight,
      });
      setIsConfirmationMode(true);

      const postDiscountPercent =
        typeof data.discount_percent === 'number' ? data.discount_percent : discountPercent;
      const postCompletelyFree = !!data.completely_free || completelyFree;
      if (typeof data.discount_percent === 'number') {
        setDiscountPercent(data.discount_percent);
      }
      if (data.completely_free) {
        setCompletelyFree(true);
      }

      const totalPrice = resolvePurchasePaymentAmountSats({
        serverTotalPrice: data.total_price,
        priceSats,
        discountPercent: postDiscountPercent,
        completelyFree: postCompletelyFree,
        selectedDuration,
        blockFee1,
        blockFee6,
        blockFee48,
        takeOnchain,
        sptrPrice,
        sptrFee1,
        sptrFee6,
        sptrFee48,
      });
      const formattedSats = totalPrice.toLocaleString();

      if (btcPriceUSD !== null) {
        const satsPerBitcoin = 100000000;
        const usdAmount = (totalPrice / satsPerBitcoin) * btcPriceUSD;
        const formattedUSD = usdAmount.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        // Update button label with USD
        const confirmLabel = `Send ${formattedSats} sats = $${formattedUSD} for ${data.handle}`;
        setButtonLabel(confirmLabel);
      } else {
        // Update button label without USD if price not available
        const confirmLabel = `Send ${formattedSats} sats for ${data.handle}`;
        setButtonLabel(confirmLabel);
      }
      setIsButtonEnabled(true);
      setButtonState('available');
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      handleSpacesPurchaseApiErrorRef.current(
        error,
        `[Spaces API] POST ${url} - Failed (${duration}ms):`
      );
    }
  };

  const handleSelectSpaceName = (option: string) => {
    setSpaceName(option);
    setShowDropdown(false);
  };

  // Helper function to shorten address for display
  const shortenAddress = (address: string): string => {
    if (address.length <= 13) {
      return address; // If address is already short, return as-is
    }
    return `${address.substring(0, 8)}...${address.substring(address.length - 5)}`;
  };

  // Handle cancel purchase - sends DELETE request
  const handleCancelPurchase = async () => {
    if (!purchaseData || !quoteId || !handle) {
      console.error('[Spaces] Missing data for cancel purchase');
      return;
    }

    const spaceNameLower = spaceName.toLowerCase();
    const url = `${SPACES_API_BASE_URL}/spaces/${spaceNameLower}/${subspace.trim()}?app=${SPACES_APP_NAME}&format=json`;
    const startTime = Date.now();
    console.log(`[Spaces API] DELETE ${url}`);

    try {
      const requestBody = {
        purchase_type: PURCHASE_TYPE_SUBNAME,
        quote_id: quoteId,
        handle: handle,
      };

      console.log('[Spaces API] DELETE request body:', JSON.stringify(requestBody, null, 2));

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[Spaces API] DELETE ${url} - HTTP error! status: ${response.status} (${duration}ms)`,
          errorText
        );
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log(`[Spaces API] DELETE ${url} - Success (${duration}ms)`, data);

      // Reset confirmation mode and clear purchase data
      setIsConfirmationMode(false);
      setPurchaseData(null);
      postPurchaseWatchRef.current = null;
      purchaseTaprootPathRef.current = null;

      // Reset button state to initial
      setButtonState('available');
      setIsButtonEnabled(true);

      // Recalculate button label based on current price and duration
      if (priceSats !== null) {
        const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48);
        if (blockFee !== null) {
          const totalLabel = calculateTotalPrice(
            priceSats,
            blockFee1,
            blockFee6,
            blockFee48,
            selectedDuration,
            btcPriceUSD,
            takeOnchain,
            sptrPrice,
            sptrFee1,
            sptrFee6,
            sptrFee48
          );
          setButtonLabel(totalLabel);
        }
      }
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      console.error(`[Spaces API] DELETE ${url} - Failed (${duration}ms):`, error);
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to cancel purchase');
    }
  };

  // Get the appropriate block fee based on selected duration
  const getBlockFee = useCallback(
    (
      duration: string,
      fee1: number | null,
      fee6: number | null,
      fee48: number | null
    ): number | null => {
      switch (duration) {
        case '~10 mins':
          return fee1;
        case '~1 hour':
          return fee6;
        case '~8 hours':
          return fee48;
        default:
          return fee1;
      }
    },
    []
  );

  // Get the appropriate SPTR block fee based on selected duration
  const getSptrFee = useCallback(
    (
      duration: string,
      fee1: number | null,
      fee6: number | null,
      fee48: number | null
    ): number | null => {
      switch (duration) {
        case '~10 mins':
          return fee1;
        case '~1 hour':
          return fee6;
        case '~8 hours':
          return fee48;
        default:
          return fee1;
      }
    },
    []
  );

  // Get the confirmation target based on selected duration
  const getConfTarget = useCallback((duration: string): number => {
    switch (duration) {
      case '~10 mins':
        return 1; // 1_block_fee
      case '~1 hour':
        return 6; // 6_block_fee
      case '~8 hours':
        return 48; // 48_block_fee
      default:
        return 1;
    }
  }, []);

  // Calculate total price (price + fee) and format button label
  const calculateTotalPrice = useCallback(
    (
      price: number | null,
      fee1: number | null,
      fee6: number | null,
      fee48: number | null,
      duration: string,
      btcPrice: number | null,
      takeOnchain: boolean,
      sptrPrice: number | null,
      sptrFee1: number | null,
      sptrFee6: number | null,
      sptrFee48: number | null
    ): string => {
      if (price === null) {
        return 'Purchase';
      }

      const blockFee = getBlockFee(duration, fee1, fee6, fee48);
      if (blockFee === null) {
        return 'Purchase';
      }

      let totalPrice = price + blockFee;
      
      // Add SPTR costs if takeOnchain is checked
      if (takeOnchain && sptrPrice !== null) {
        const sptrFee = getSptrFee(duration, sptrFee1, sptrFee6, sptrFee48);
        if (sptrFee !== null) {
          totalPrice += sptrPrice + sptrFee;
        }
      }
      // Format sats with commas for readability
      const formattedSats = totalPrice.toLocaleString();

      // Calculate USD: (total_price_sats / 100,000,000) * btc_price_usd
      if (btcPrice === null) {
        return `Purchase for ${formattedSats} sats`;
      }

      const satsPerBitcoin = 100000000;
      const usdAmount = (totalPrice / satsPerBitcoin) * btcPrice;

      // Format USD with commas and 2 decimal places
      const formattedUSD = usdAmount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

      return `Purchase for ${formattedSats} sats = $${formattedUSD}`;
    },
    [getBlockFee, getSptrFee]
  );

  // Calculate displayed total with coupon discount applied to price only (block_fee never discounted)
  const getDiscountedTotal = useCallback((): number | null => {
    if (!purchaseData || priceSats === null) return null;
    return resolvePurchasePaymentAmountSats({
      serverTotalPrice: purchaseData.total_price,
      priceSats,
      discountPercent,
      completelyFree,
      selectedDuration,
      blockFee1,
      blockFee6,
      blockFee48,
      takeOnchain,
      sptrPrice,
      sptrFee1,
      sptrFee6,
      sptrFee48,
    });
  }, [
    completelyFree,
    discountPercent,
    priceSats,
    purchaseData,
    selectedDuration,
    blockFee1,
    blockFee6,
    blockFee48,
    takeOnchain,
    sptrPrice,
    sptrFee1,
    sptrFee6,
    sptrFee48,
  ]);

  // Initialize pricing service and fetch BTC price
  useEffect(() => {
    const showPricingUnavailableToast = (force = false) => {
      const now = Date.now();
      if (!force && now - pricingUnavailableToastAtRef.current < 120_000) {
        return;
      }
      pricingUnavailableToastAtRef.current = now;
      toast.error(
        `The pricing service (${getPricingServiceHostname()}) is temporarily unavailable. Please try again later.`
      );
    };

    const loadBtcPrice = async () => {
      try {
        // Initialize pricing service if not already initialized
        if (!pricingService.isReady()) {
          await pricingService.initialize();
        }

        // Get BTC/USD price
        const btcPrice = pricingService.getExchangeRate(AssetTicker.BTC, FiatCurrency.USD);
        if (btcPrice) {
          setBtcPriceUSD(btcPrice);
        } else {
          // If not in cache, fetch it
          await pricingService.refreshExchangeRates();
          const refreshedPrice = pricingService.getExchangeRate(AssetTicker.BTC, FiatCurrency.USD);
          setBtcPriceUSD(refreshedPrice ?? null);
        }
      } catch {
        showPricingUnavailableToast(true);
        const cachedPrice = pricingService.getExchangeRate(AssetTicker.BTC, FiatCurrency.USD);
        setBtcPriceUSD(cachedPrice ?? null);
      }
    };

    loadBtcPrice();

    // Refresh BTC price every 30 seconds
    const interval = setInterval(async () => {
      try {
        if (pricingService.isReady()) {
          await pricingService.refreshExchangeRates();
          const refreshedPrice = pricingService.getExchangeRate(AssetTicker.BTC, FiatCurrency.USD);
          if (refreshedPrice) {
            setBtcPriceUSD(refreshedPrice);
          }
        }
      } catch {
        showPricingUnavailableToast();
      }
    }, 30000); // 30 seconds

    return () => clearInterval(interval);
  }, []);

  // Load space names from API when component mounts
  useEffect(() => {
    const loadSpaces = async () => {
      const url = `${SPACES_API_BASE_URL}/getspaces?app=${SPACES_APP_NAME}`;
      const startTime = Date.now();
      console.log(`[Spaces API] GET ${url}`);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        const endTime = Date.now();
        const duration = endTime - startTime;

        if (!response.ok) {
          console.error(
            `[Spaces API] GET ${url} - HTTP error! status: ${response.status} (${duration}ms)`
          );
          if (response.status >= 500) {
            toast.error('Spaces server is temporarily unavailable. Please try again later.');
          }
          return;
        }

        const data: GetSpacesResponse = await response.json();
        console.log(`[Spaces API] GET ${url} - Success (${duration}ms)`);

        if (data.spaces && Array.isArray(data.spaces)) {
          // Extract space_name from each object
          const spaceNames = data.spaces
            .map((item) => item.space_name)
            .filter((name): name is string => typeof name === 'string' && name.length > 0);
          setSpaceNameOptions(spaceNames);
        }
      } catch (error) {
        const endTime = Date.now();
        const duration = endTime - startTime;

        if (error instanceof TypeError && error.message.includes('Network request failed')) {
          console.error(
            `[Spaces API] GET ${url} - Network failure (${duration}ms):`,
            error.message
          );
        } else {
          console.error(`[Spaces API] GET ${url} - Failed (${duration}ms):`, error);
        }
        toast.error('Unable to reach Spaces server. Please try again later.');
        // Keep default options on error
      }
    };

    loadSpaces();
  }, []);

  // If the user types a subspace before choosing space_name, warn once (until they pick a space or clear subspace)
  useEffect(() => {
    const hasSub = subspace.trim().length > 0;
    const hasSpace = Boolean(spaceName?.trim());
    if (hasSub && !hasSpace) {
      if (!subspaceBeforeSpaceNameWarnedRef.current) {
        toast.warning('Select a space name first, then enter your subspace.');
        subspaceBeforeSpaceNameWarnedRef.current = true;
      }
    } else {
      subspaceBeforeSpaceNameWarnedRef.current = false;
    }
  }, [subspace, spaceName]);

  // Check space availability when subspace or spaceName changes
  const checkAvailability = useCallback(async () => {
    // Only make request if both fields have values
    if (!subspace.trim() || !spaceName) {
      setButtonState(null);
      setIsButtonEnabled(false);
      setButtonLabel(idlePurchaseButtonLabel(subspace, spaceName));
      setPriceSats(null);
      setBlockFee1(null);
      setBlockFee6(null);
      setBlockFee48(null);
      setSptrPrice(null);
      setSptrFee1(null);
      setSptrFee6(null);
      setSptrFee48(null);
      return;
    }

    setButtonState('loading');
    setIsButtonEnabled(false);
    setButtonLabel('Checking...');

    const spaceNameLower = spaceName.toLowerCase();
    const url = `${SPACES_API_BASE_URL}/spaces/${spaceNameLower}/${subspace.trim()}?app=${SPACES_APP_NAME}&format=json`;
    const startTime = Date.now();
    console.log(`[Spaces API] GET ${url}`);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      if (!response.ok) {
        let bodyPreview = '';
        try {
          bodyPreview = (await response.text()).slice(0, 500);
        } catch {
          /* ignore */
        }
        const hint =
          response.status === 503 || response.status === 502
            ? ' (server/CGI unavailable or overloaded — retry later)'
            : '';
        console.error(
          `[Spaces API] GET ${url} - HTTP ${response.status} ${response.statusText}${hint} (${duration}ms)`,
          bodyPreview ? `body: ${bodyPreview}` : 'empty body'
        );
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: SpaceAvailabilityResponse = await response.json();
      console.log(`[Spaces API] GET ${url} - Success (${duration}ms)`);

      if (data.state === 'available') {
        setButtonState('available');
        setIsButtonEnabled(true);
        setIsConfirmationMode(false); // Reset confirmation mode
        setPurchaseData(null); // Clear previous purchase data

        // Store price and block fees if available
        // The recalculation useEffect will update the button label
        if (data.price !== undefined && data.price !== null) {
          setPriceSats(data.price);

          // Store handle and quote_id (id field)
          if (data.handle) {
            setHandle(data.handle);
            console.log('[Spaces] Stored handle:', data.handle);
          } else {
            setHandle(null);
          }

          if (data.id !== undefined && data.id !== null) {
            setQuoteId(data.id);
            console.log('[Spaces] Stored quoteId:', data.id);
          } else {
            setQuoteId(null);
          }

          // Block fees can be 0, so check for undefined/null specifically
          const fee1Value =
            data['1_block_fee'] !== undefined && data['1_block_fee'] !== null
              ? data['1_block_fee']
              : null;
          const fee6Value =
            data['6_block_fee'] !== undefined && data['6_block_fee'] !== null
              ? data['6_block_fee']
              : null;
          const fee48Value =
            data['48_block_fee'] !== undefined && data['48_block_fee'] !== null
              ? data['48_block_fee']
              : null;
          setBlockFee1(fee1Value);
          setBlockFee6(fee6Value);
          setBlockFee48(fee48Value);

          // Store SPTR price and fees (ensure they're numbers)
          const sptrPriceValue =
            data.sptr_price !== undefined && data.sptr_price !== null
              ? Number(data.sptr_price)
              : null;
          const sptrFee1Value =
            data['1_block_sptr_fee'] !== undefined && data['1_block_sptr_fee'] !== null
              ? Number(data['1_block_sptr_fee'])
              : null;
          const sptrFee6Value =
            data['6_block_sptr_fee'] !== undefined && data['6_block_sptr_fee'] !== null
              ? Number(data['6_block_sptr_fee'])
              : null;
          const sptrFee48Value =
            data['48_block_sptr_fee'] !== undefined && data['48_block_sptr_fee'] !== null
              ? Number(data['48_block_sptr_fee'])
              : null;
          setSptrPrice(sptrPriceValue);
          setSptrFee1(sptrFee1Value);
          setSptrFee6(sptrFee6Value);
          setSptrFee48(sptrFee48Value);
          console.log(
            `[Spaces] API response: price=${data.price}, handle=${data.handle}, id=${data.id}, 1_block_fee=${fee1Value}, 6_block_fee=${fee6Value}, 48_block_fee=${fee48Value}, sptr_price=${sptrPriceValue}, 1_block_sptr_fee=${sptrFee1Value}, 6_block_sptr_fee=${sptrFee6Value}, 48_block_sptr_fee=${sptrFee48Value}`
          );
          // Don't set button label here - let the recalculation useEffect handle it
        } else {
          setPriceSats(null);
          setBlockFee1(null);
          setBlockFee6(null);
          setBlockFee48(null);
          setSptrPrice(null);
          setSptrFee1(null);
          setSptrFee6(null);
          setSptrFee48(null);
          setHandle(null);
          setQuoteId(null);
          setButtonLabel('Purchase');
        }
      } else if (data.state === 'taken') {
        setButtonState('taken');
        setIsButtonEnabled(false);
        setButtonLabel('Taken');
        setPriceSats(null);
        setBlockFee1(null);
        setBlockFee6(null);
        setBlockFee48(null);
        setSptrPrice(null);
        setSptrFee1(null);
        setSptrFee6(null);
        setSptrFee48(null);
        setIsConfirmationMode(false);
        setPurchaseData(null);
        setHandle(null);
        setQuoteId(null);
      } else if (data.state === 'unavailable') {
        setButtonState('reserved');
        setIsButtonEnabled(false);
        setButtonLabel('Reserved');
        setPriceSats(null);
        setBlockFee1(null);
        setBlockFee6(null);
        setBlockFee48(null);
        setSptrPrice(null);
        setSptrFee1(null);
        setSptrFee6(null);
        setSptrFee48(null);
        setIsConfirmationMode(false);
        setPurchaseData(null);
        setHandle(null);
        setQuoteId(null);
      } else {
        // Unknown state
        setButtonState(null);
        setIsButtonEnabled(false);
        setButtonLabel('Purchase');
        setPriceSats(null);
        setBlockFee1(null);
        setBlockFee6(null);
        setBlockFee48(null);
        setIsConfirmationMode(false);
        setPurchaseData(null);
        setHandle(null);
        setQuoteId(null);
      }
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      if (error instanceof TypeError && error.message.includes('Network request failed')) {
        console.error(
          `[Spaces API] GET ${url} - Network failure (${duration}ms):`,
          error.message
        );
      } else {
        console.error(`[Spaces API] GET ${url} - Failed (${duration}ms):`, error);
      }

      setButtonState(null);
      setIsButtonEnabled(false);
      setButtonLabel('Purchase');
      setPriceSats(null);
      setBlockFee1(null);
      setBlockFee6(null);
      setBlockFee48(null);
      setSptrPrice(null);
      setSptrFee1(null);
      setSptrFee6(null);
      setSptrFee48(null);
      setIsConfirmationMode(false);
      setPurchaseData(null);
      setHandle(null);
      setQuoteId(null);
    }
  }, [subspace, spaceName]);

  useEffect(() => {
    refreshSpaceQuoteRef.current = checkAvailability;
  }, [checkAvailability]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void checkAvailability();
    }, 500); // Wait 500ms after user stops typing

    return () => clearTimeout(timeoutId);
  }, [checkAvailability]);

  const handleSpacesPurchaseApiError = useCallback((error: unknown, logContext: string) => {
    console.error(logContext, error);

    const message =
      error instanceof SpacesApiHttpError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Failed to process purchase';
    const refreshQuote = error instanceof SpacesApiHttpError && error.refreshQuote;

    setIsConfirmationMode(false);
    setPurchaseData(null);
    postPurchaseWatchRef.current = null;
    purchaseTaprootPathRef.current = null;

    if (refreshQuote) {
      Alert.alert('Quote unavailable', `${message}\n\nFetching a new quote…`);
      void refreshSpaceQuoteRef.current?.();
      return;
    }

    setButtonState(null);
    setIsButtonEnabled(false);
    setButtonLabel(idlePurchaseButtonLabel(subspace, spaceName));
    Alert.alert('Error', message);
  }, [subspace, spaceName]);

  handleSpacesPurchaseApiErrorRef.current = handleSpacesPurchaseApiError;

  // Persist mySpaces to AsyncStorage whenever it changes
  useEffect(() => {
    const persistMySpaces = async () => {
      try {
        await AsyncStorage.setItem('mySpaces', JSON.stringify(mySpaces));
        console.log('[Spaces] Persisted mySpaces to AsyncStorage:', mySpaces.length, 'spaces');
      } catch (error) {
        console.error('[Spaces] Failed to persist mySpaces:', error);
      }
    };

    if (mySpaces.length > 0) {
      persistMySpaces();
    }
  }, [mySpaces]);

  // Load mySpaces from AsyncStorage
  const loadMySpaces = useCallback(async () => {
    try {
      const stored = await AsyncStorage.getItem('mySpaces');
      if (stored) {
        const loadedSpaces = JSON.parse(stored);
        console.log('[Spaces] Loaded mySpaces from AsyncStorage:', loadedSpaces.length, 'spaces');
        setMySpaces(loadedSpaces);

        // Resume polling for active jobs
        const terminalStates: UnifiedStatus[] = ['certificate_delivered', 'sptr_delivered', 'expired', 'cancelled'];
        const activeSpaces = loadedSpaces.filter(
          (space: {
            jobId?: number;
            status: UnifiedStatus;
            chainPresence?: 'on-chain' | 'off-chain';
          }) =>
            space.jobId &&
            !terminalStates.includes(space.status) &&
            space.chainPresence !== 'on-chain'
        );

        if (activeSpaces.length > 0) {
          console.log('[Spaces] Resuming polling for', activeSpaces.length, 'active jobs');
          activeSpaces.forEach(
            (space: {
              jobId: number;
              subspace: string;
              spaceName: string;
              unifiedStatusPurchaseType?: 'subname' | 'pointer';
            }) => {
              pollJobStatus(space.jobId, space.spaceName, space.subspace, {
                unifiedStatusPurchaseType: space.unifiedStatusPurchaseType ?? 'subname',
              }).catch((error) => {
                console.error(
                  '[Spaces] Failed to resume polling for job',
                  space.jobId,
                  ':',
                  error
                );
              });
            }
          );
        }
      }
    } catch (error) {
      console.error('[Spaces] Failed to load mySpaces from AsyncStorage:', error);
    }
  }, []);

  // Load mySpaces on component mount
  useEffect(() => {
    loadMySpaces();
  }, [loadMySpaces]);

  // Reload mySpaces when screen comes into focus (e.g., after deleting a space)
  useFocusEffect(
    useCallback(() => {
      loadMySpaces();
    }, [loadMySpaces])
  );

  // Update countdown timers every second for active polling jobs
  useEffect(() => {
    const activeJobs = Object.keys(jobPollingState).filter(
      (jobId) => jobPollingState[Number(jobId)]?.isPolling
    );

    if (activeJobs.length === 0) return;

    const interval = setInterval(() => {
      // Force re-render to update countdown timers
      setJobPollingState((prev) => ({ ...prev }));
    }, 1000);

    return () => clearInterval(interval);
  }, [jobPollingState]);

  // Reset coupon state when leaving confirmation mode
  useEffect(() => {
    if (!isConfirmationMode) {
      setCouponCode('');
      setDiscountPercent(null);
      setCompletelyFree(false);
      setCouponStatus('idle');
    }
  }, [isConfirmationMode]);

  // Validate coupon code with 2-second debounce after user stops typing
  useEffect(() => {
    if (!isConfirmationMode) return;

    if (!couponCode.trim()) {
      setDiscountPercent(null);
      setCompletelyFree(false);
      setCouponStatus('idle');
      return;
    }

    setCouponStatus('validating');

    const timeoutId = setTimeout(async () => {
      try {
        const spaceNameLower = spaceName.toLowerCase();
        const url = `${SPACES_API_BASE_URL}/api/spaces/${spaceNameLower}/validate-coupon`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: couponCode.trim().toUpperCase() }),
        });
        const data = await response.json();
        if (data.success && data.valid) {
          setDiscountPercent(data.discount_percent);
          setCompletelyFree(!!data.completely_free);
          setCouponStatus('valid');
          toast.success(data.message || `Coupon applied: ${data.discount_percent}% off`);
        } else {
          setDiscountPercent(null);
          setCompletelyFree(false);
          setCouponStatus('invalid');
          toast.error(data.message || 'Invalid coupon code');
        }
      } catch {
        setDiscountPercent(null);
        setCompletelyFree(false);
        setCouponStatus('invalid');
        toast.error('Could not validate coupon');
      }
    }, 2000);

    return () => clearTimeout(timeoutId);
  }, [couponCode, isConfirmationMode, spaceName]);

  // Recalculate price when duration changes or BTC price updates
  useEffect(() => {
    if (buttonState === 'available' && priceSats !== null) {
      const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48);
      if (blockFee !== null) {
        const totalPriceSats = priceSats + blockFee;
        console.log(
          `[Spaces] Recalculating price: duration=${selectedDuration}, price=${priceSats}, blockFee=${blockFee}, totalPriceSats=${totalPriceSats}, btcPriceUSD=${btcPriceUSD}`
        );
        const totalLabel = calculateTotalPrice(
          priceSats,
          blockFee1,
          blockFee6,
          blockFee48,
          selectedDuration,
          btcPriceUSD,
          takeOnchain,
          sptrPrice,
          sptrFee1,
          sptrFee6,
          sptrFee48
        );
        setButtonLabel(totalLabel);
      } else {
        setButtonLabel('Purchase');
      }
    }
  }, [
    selectedDuration,
    priceSats,
    blockFee1,
    blockFee6,
    blockFee48,
    buttonState,
    btcPriceUSD,
    takeOnchain,
    sptrPrice,
    sptrFee1,
    sptrFee6,
    sptrFee48,
    calculateTotalPrice,
    getBlockFee,
  ]);

  // Keep confirmation-mode button label in sync when coupon discount changes
  useEffect(() => {
    if (!isConfirmationMode || !purchaseData) return;

    if (completelyFree) {
      setButtonLabel(`Request ${purchaseData.handle} for free`);
      return;
    }

    const displayTotal = resolvePurchasePaymentAmountSats({
      serverTotalPrice: purchaseData.total_price,
      priceSats,
      discountPercent,
      completelyFree,
      selectedDuration,
      blockFee1,
      blockFee6,
      blockFee48,
      takeOnchain,
      sptrPrice,
      sptrFee1,
      sptrFee6,
      sptrFee48,
    });

    const formattedSats = displayTotal.toLocaleString();

    if (btcPriceUSD !== null) {
      const usdAmount = (displayTotal / 100000000) * btcPriceUSD;
      const formattedUSD = usdAmount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      setButtonLabel(`Send ${formattedSats} sats = $${formattedUSD} for ${purchaseData.handle}`);
    } else {
      setButtonLabel(`Send ${formattedSats} sats for ${purchaseData.handle}`);
    }
  }, [completelyFree, discountPercent, couponStatus, isConfirmationMode, purchaseData, btcPriceUSD, priceSats, selectedDuration, blockFee1, blockFee6, blockFee48, takeOnchain, sptrPrice, sptrFee1, sptrFee6, sptrFee48]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Header title="Spaces" />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Search Section */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => setIsFindPurchaseExpanded(!isFindPurchaseExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.collapsibleHeaderLeft}>
              {isFindPurchaseExpanded ? (
                <ChevronDown size={20} color={colors.textSecondary} />
              ) : (
                <ChevronRight size={20} color={colors.textSecondary} />
              )}
              <Text style={styles.collapsibleHeaderText}>Find & Purchase</Text>
            </View>
          </TouchableOpacity>
          {isFindPurchaseExpanded && (
            <View style={styles.searchCard}>
              <View style={styles.searchRow}>
              <TextInput
                style={styles.subspaceInput}
                placeholder="subspace"
                placeholderTextColor={colors.textSecondary}
                value={subspace}
                onChangeText={setSubspace}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.atSymbol}>@</Text>
              <TouchableOpacity
                style={styles.dropdownButton}
                onPress={() => setShowDropdown(true)}
                activeOpacity={0.7}
              >
                <Text style={[styles.dropdownText, !spaceName && styles.dropdownPlaceholder]}>
                  {spaceName || 'space_name'}
                </Text>
                <ChevronDown size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>


            {/* Confirmation message - Shown in confirmation mode */}
            {isConfirmationMode && purchaseData && (
              <View style={styles.confirmationMessage}>
                <View style={styles.purchaseOrderTable}>
                  <View style={styles.purchaseOrderHeader}>
                    <Text style={styles.purchaseOrderHeaderText}>Item</Text>
                    <Text style={styles.purchaseOrderHeaderText}>Price</Text>
                  </View>
                  <View style={styles.purchaseOrderRow}>
                    <Text style={styles.purchaseOrderItemText}>
                      {subspace.trim()}@{spaceName.toLowerCase()}
                    </Text>
                    <Text style={styles.purchaseOrderPriceText}>
                      {priceSats?.toLocaleString() || '0'} sats
                    </Text>
                  </View>
                  <View style={styles.purchaseOrderRow}>
                    <Text style={styles.purchaseOrderItemText}>transaction fee</Text>
                    <Text style={styles.purchaseOrderPriceText}>
                      {getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48)?.toLocaleString() || '0'} sats
                    </Text>
                  </View>
                  {takeOnchain && sptrPrice !== null && (
                    <>
                      <View style={styles.purchaseOrderRow}>
                        <Text style={styles.purchaseOrderItemText}>onchain</Text>
                        <Text style={styles.purchaseOrderPriceText}>
                          {sptrPrice.toLocaleString()} sats
                        </Text>
                      </View>
                      <View style={styles.purchaseOrderRow}>
                        <Text style={styles.purchaseOrderItemText}>onchain fee</Text>
                        <Text style={styles.purchaseOrderPriceText}>
                          {getSptrFee(selectedDuration, sptrFee1, sptrFee6, sptrFee48)?.toLocaleString() || '0'} sats
                        </Text>
                      </View>
                    </>
                  )}
                  {/* Coupon code input */}
                  <View style={styles.couponRow}>
                    <TextInput
                      style={[
                        styles.couponInput,
                        couponStatus === 'valid' && styles.couponInputValid,
                        couponStatus === 'invalid' && styles.couponInputInvalid,
                      ]}
                      placeholder="Coupon code (optional)"
                      placeholderTextColor={colors.textSecondary}
                      value={couponCode}
                      onChangeText={(text) => {
                        setCouponCode(text);
                        if (couponStatus !== 'idle') setCouponStatus('idle');
                        if (discountPercent !== null) setDiscountPercent(null);
                        if (completelyFree) setCompletelyFree(false);
                      }}
                      autoCapitalize="characters"
                      autoCorrect={false}
                    />
                    {couponStatus === 'validating' && (
                      <Text style={styles.couponStatusChecking}>Checking…</Text>
                    )}
                    {couponStatus === 'valid' && discountPercent !== null && (
                      <Text style={styles.couponStatusValid}>-{discountPercent}%</Text>
                    )}
                    {couponStatus === 'invalid' && (
                      <Text style={styles.couponStatusInvalid}>Invalid</Text>
                    )}
                  </View>

                  {/* Discount row — only visible when coupon is valid */}
                  {couponStatus === 'valid' && discountPercent !== null && priceSats !== null && (
                    <View style={styles.purchaseOrderRow}>
                      <Text style={styles.purchaseOrderItemText}>coupon discount</Text>
                      <Text style={[styles.purchaseOrderPriceText, styles.discountAmountText]}>
                        -{Math.floor(priceSats * discountPercent / 100).toLocaleString()} sats
                      </Text>
                    </View>
                  )}
                  {/* Fee discount row — negate transaction fee when coupon makes purchase completely free */}
                  {completelyFree && (
                    <View style={styles.purchaseOrderRow}>
                      <Text style={styles.purchaseOrderItemText}>fee discount</Text>
                      <Text style={[styles.purchaseOrderPriceText, styles.discountAmountText]}>
                        -{(getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48) ?? 0).toLocaleString()} sats
                      </Text>
                    </View>
                  )}

                  <View style={[styles.purchaseOrderRow, styles.purchaseOrderTotalRow]}>
                    <Text style={styles.purchaseOrderTotalText}>Total</Text>
                    <Text style={styles.purchaseOrderTotalPriceText}>
                      {(getDiscountedTotal() ?? (() => {
                        let total = purchaseData.total_price;
                        if (takeOnchain && sptrPrice !== null) {
                          const sptrFee = getSptrFee(selectedDuration, sptrFee1, sptrFee6, sptrFee48);
                          if (sptrFee !== null) total += sptrPrice + sptrFee;
                        }
                        return total;
                      })()).toLocaleString()} sats
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Take Onchain — hidden for now; re-enable when SPTR pointer purchase at quote time is ready again.
            {!isConfirmationMode && (
              <TouchableOpacity
                style={styles.checkboxContainer}
                onPress={() => setTakeOnchain(!takeOnchain)}
                activeOpacity={0.7}>
                <View style={[styles.checkbox, takeOnchain && styles.checkboxChecked]}>
                  {takeOnchain && <Check size={16} color={colors.black} />}
                </View>
                <Text style={styles.checkboxLabel}>
                  Take onchain for {sptrPrice?.toLocaleString() || '0'} +{' '}
                  {getSptrFee(selectedDuration, sptrFee1, sptrFee6, sptrFee48)?.toLocaleString() || '0'} sats
                </Text>
              </TouchableOpacity>
            )}
            */}

            <TouchableOpacity
              style={[
                styles.purchaseButton,
                !isButtonEnabled && styles.purchaseButtonDisabled,
                buttonState === 'loading' && styles.purchaseButtonLoading,
              ]}
              onPress={handlePurchase}
              disabled={!isButtonEnabled}
              activeOpacity={isButtonEnabled ? 0.7 : 1}
            >
              <Text
                style={[
                  styles.purchaseButtonText,
                  !isButtonEnabled && styles.purchaseButtonTextDisabled,
                ]}
              >
                {buttonLabel}
              </Text>
            </TouchableOpacity>

            {/* Cancel Purchase button - Shown in confirmation mode */}
            {isConfirmationMode && (
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={handleCancelPurchase}
                activeOpacity={0.7}
              >
                <Text style={styles.cancelButtonText}>Cancel Purchase</Text>
              </TouchableOpacity>
            )}
            </View>
          )}
        </View>

        {/* Transaction Hex Modal */}
        <Modal
          visible={showTxHexModal}
          transparent={true}
          animationType="fade"
          onRequestClose={finishPurchaseTxFlow}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Transaction Hex</Text>
              <ScrollView style={styles.txHexContainer}>
                <Text style={styles.txHexText} selectable>
                  {txHex}
                </Text>
              </ScrollView>
              <View style={styles.modalButtonRow}>
                <TouchableOpacity
                  style={styles.modalCopyButton}
                  onPress={handleCopyTxHex}
                  activeOpacity={0.7}
                >
                  <Copy size={18} color={colors.black} />
                  <Text style={styles.modalCopyButtonText}>Copy</Text>
                </TouchableOpacity>
              </View>
              <View style={[styles.modalButtonRow, styles.modalButtonRowSpacing]}>
                <TouchableOpacity
                  style={styles.modalDismissButton}
                  onPress={finishPurchaseTxFlow}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalDismissButtonText}>Cancel</Text>
                </TouchableOpacity>
                {/* Simulate (dev-only dummy txid): re-enable when simulating watch-payment without broadcast is needed again.
                <TouchableOpacity
                  style={styles.modalSimulateButton}
                  onPress={handleSimulate}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalSimulateButtonText}>Simulate</Text>
                </TouchableOpacity>
                */}
                <TouchableOpacity
                  style={styles.modalBroadcastButton}
                  onPress={handleBroadcast}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalBroadcastButtonText}>Proceed</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Spaces List Section */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => setIsMySpacesExpanded(!isMySpacesExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.collapsibleHeaderLeft}>
              {isMySpacesExpanded ? (
                <ChevronDown size={20} color={colors.textSecondary} />
              ) : (
                <ChevronRight size={20} color={colors.textSecondary} />
              )}
              <AtSign size={20} color={colors.primary} />
              <Text style={styles.collapsibleHeaderText}>My Spaces</Text>
            </View>
          </TouchableOpacity>

          {isMySpacesExpanded && (
            <>
          {mySpaces.length === 0 ? (
            <View style={styles.infoCard}>
              <Text style={styles.emptyText}>No spaces yet</Text>
              <Text style={styles.emptySubtext}>
                Search for and purchase a space above, or scan for existing spaces by pressing the
                Find Spaces button.
              </Text>
            </View>
          ) : (
            <View style={styles.tableContainer}>
              {/* Table Header */}
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderText, styles.tableHeaderColSpace]}>Space</Text>
                <TouchableOpacity
                  style={[styles.tableHeaderColStatus, styles.tableHeaderStatusButton]}
                  onPress={handleRefreshAllMySpacesStatuses}
                  disabled={isRefreshingMySpacesStatuses || mySpaces.length === 0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Status, tap to refresh all handle statuses"
                >
                  {isRefreshingMySpacesStatuses ? (
                    <ActivityIndicator size="small" color={colors.text} />
                  ) : (
                    <Text
                      style={[
                        styles.tableHeaderText,
                        mySpaces.length === 0 && styles.tableHeaderStatusTextDisabled,
                      ]}
                    >
                      Status
                    </Text>
                  )}
                </TouchableOpacity>
                <View style={styles.tableHeaderColCheck} />
              </View>
              {/* Table Rows */}
              {mySpaces.map((space, index) => {
                const timeUntilNextCheck = getTimeUntilNextCheck(space.subspace, space.spaceName);
                const statusText = getSpaceStatus(space.subspace, space.spaceName);
                const showCountdown = timeUntilNextCheck !== null;

                return (
                  <View
                    key={`${space.spaceName}-${space.subspace}-${index}`}
                    style={[styles.tableRow, index === mySpaces.length - 1 && styles.tableRowLast]}
                  >
                    <TouchableOpacity
                      style={[styles.tableCellSpace, styles.tableColSpace]}
                      onPress={() => handleSubspaceSelect(space)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.tableCellSpaceText} numberOfLines={1}>
                        {space.subspace}@{space.spaceName}
                      </Text>
                    </TouchableOpacity>
                    <View style={[styles.tableCellStatus, styles.tableColStatus]}>
                      <Text style={styles.tableCellStatusText} numberOfLines={1}>
                        {statusText}
                      </Text>
                    </View>
                    <View style={[styles.tableCellNextCheck, styles.tableColCheck]}>
                      <Text style={styles.tableCellNextCheckText} numberOfLines={1}>
                        {showCountdown && timeUntilNextCheck !== null
                          ? `${timeUntilNextCheck} min`
                          : '-'}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          <TouchableOpacity
            style={styles.findSpacesButton}
            onPress={handleFindSpaces}
            activeOpacity={0.7}
          >
            <Text style={styles.findSpacesButtonText}>Find Spaces</Text>
          </TouchableOpacity>
            </>
          )}
        </View>

        {/* Query Subspace Section */}
        <View style={styles.section}>
          <View style={styles.collapsibleHeaderRow}>
            <TouchableOpacity
              style={styles.collapsibleHeader}
              onPress={toggleQuerySubspaceExpanded}
              activeOpacity={0.7}
            >
              <View style={styles.collapsibleHeaderLeft}>
                {isQuerySubspaceExpanded ? (
                  <ChevronDown size={20} color={colors.textSecondary} />
                ) : (
                  <ChevronRight size={20} color={colors.textSecondary} />
                )}
                <Text style={styles.collapsibleHeaderText}>Query Subspace</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.noDnsToggle}>
              <Text style={styles.noDnsLabel}>No-DNS</Text>
              <Switch
                value={queryNoDns}
                onValueChange={handleQueryNoDnsChange}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor={colors.white}
              />
            </View>
          </View>
          {isQuerySubspaceExpanded && (
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>Anchors servers</Text>
              <Text style={styles.infoValue}>{anchorsServerHostname ?? '—'}</Text>
              <View style={styles.querySubspaceRow}>
                <TextInput
                  style={[styles.subspaceInput, !anchorsReady && styles.queryInputDisabled]}
                  placeholder="spaces name"
                  placeholderTextColor={colors.textSecondary}
                  value={querySpacesName}
                  onChangeText={setQuerySpacesName}
                  editable={anchorsReady}
                  keyboardType="email-address"
                  autoComplete="off"
                  textContentType="none"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={[
                    styles.querySearchButton,
                    (!anchorsReady || !querySpacesName.trim() || isQuerySearchInFlight) &&
                      styles.querySearchButtonDisabled,
                  ]}
                  onPress={() => void handleQuerySpacesSearch()}
                  disabled={!anchorsReady || !querySpacesName.trim() || isQuerySearchInFlight}
                  activeOpacity={0.7}
                >
                  <Search
                    size={20}
                    color={
                      anchorsReady && querySpacesName.trim() && !isQuerySearchInFlight
                        ? colors.text
                        : colors.textSecondary
                    }
                  />
                </TouchableOpacity>
              </View>
              {isQuerySearchInFlight && (
                <View style={styles.queryResultStatusRow}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                  <Text style={styles.queryResultStatusText}>Querying and verifying…</Text>
                </View>
              )}
              {queryVerifyError && !isQuerySearchInFlight && (
                <Text
                  style={
                    queryRequestedHandleFound === false && queryVerifiedZones.length > 0
                      ? styles.queryVerifyWarningText
                      : styles.queryVerifyErrorText
                  }
                >
                  {queryVerifyError}
                </Text>
              )}
              {queryVerifiedZones.length > 0 && !isQuerySearchInFlight && (
                <View style={styles.queryResultsSection}>
                  {queryVerifiedZones.map((zone, zoneIndex) => {
                    const orderedAttributes = orderZoneAttributes(zone.attributes);
                    const orderedFallbackAttributes = orderZoneAttributes(zone.fallbackAttributes);
                    const hasFallback = orderedFallbackAttributes.length > 0;
                    const isLastZone = zoneIndex === queryVerifiedZones.length - 1;
                    return (
                      <View
                        key={`${zone.handle}-${zone.canonical}`}
                        style={[styles.queryZoneCard, isLastZone && styles.queryZoneCardLast]}
                      >
                        <Text style={styles.queryZoneTitle}>
                          {zone.handle}
                          <Text style={styles.queryZoneSovereignty}> → {zone.sovereignty}</Text>
                        </Text>
                        {zone.alias ? (
                          <Text style={styles.queryZoneMeta}>alias: {zone.alias}</Text>
                        ) : null}
                        {orderedAttributes.length === 0 && !hasFallback ? (
                          <Text style={styles.queryNoRecords}>No published records</Text>
                        ) : (
                          <>
                            {orderedAttributes.length === 0 ? (
                              <Text style={styles.queryNoRecords}>No published records</Text>
                            ) : (
                              orderedAttributes.map((attr, attrIndex) => {
                                const isLastPrimary =
                                  !hasFallback && attrIndex === orderedAttributes.length - 1;
                                return (
                                  <View
                                    key={`${zone.handle}-${attr.type}-${attr.key}`}
                                    style={[styles.infoRow, isLastPrimary && styles.infoRowLast]}
                                  >
                                    <Text style={styles.infoLabel}>
                                      {formatZoneAttributeLabel(attr)}
                                    </Text>
                                    <Text style={styles.infoValue} selectable>
                                      {formatZoneAttributeValue(attr)}
                                    </Text>
                                  </View>
                                );
                              })
                            )}
                            {hasFallback ? (
                              <>
                                <Text style={styles.queryFallbackHeading}>Fallback</Text>
                                {orderedFallbackAttributes.map((attr, attrIndex) => {
                                  const isLastFallback =
                                    attrIndex === orderedFallbackAttributes.length - 1;
                                  return (
                                    <View
                                      key={`${zone.handle}-fallback-${attr.type}-${attr.key}`}
                                      style={[
                                        styles.infoRow,
                                        isLastFallback && styles.infoRowLast,
                                      ]}
                                    >
                                      <Text style={styles.infoLabel}>
                                        {formatZoneAttributeLabel(attr)}
                                      </Text>
                                      <Text style={styles.infoValue} selectable>
                                        {formatZoneAttributeValue(attr)}
                                      </Text>
                                    </View>
                                  );
                                })}
                              </>
                            ) : null}
                          </>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          )}
        </View>

        {/* Info Section */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => setIsAboutSpacesExpanded(!isAboutSpacesExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.collapsibleHeaderLeft}>
              {isAboutSpacesExpanded ? (
                <ChevronDown size={20} color={colors.textSecondary} />
              ) : (
                <ChevronRight size={20} color={colors.textSecondary} />
              )}
              <Text style={styles.collapsibleHeaderText}>About Spaces</Text>
            </View>
          </TouchableOpacity>
          {isAboutSpacesExpanded && (
            <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>What are Spaces?</Text>
              <Text style={styles.infoValue}>
                Spaces are customizable environments for organizing your digital assets and
                activities.
              </Text>
            </View>

            <View style={[styles.infoRow, styles.infoRowLast]}>
              <Text style={styles.infoLabel}>Features</Text>
              <Text style={styles.infoValue}>Create, manage, and organize your spaces</Text>
            </View>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Dropdown Modal */}
      <Modal
        visible={showDropdown}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowDropdown(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowDropdown(false)}
        >
          <View style={styles.dropdownContainer}>
            {spaceNameOptions.map((option) => (
              <TouchableOpacity
                key={option}
                style={[
                  styles.dropdownOption,
                  spaceName === option && styles.dropdownOptionSelected,
                ]}
                onPress={() => handleSelectSpaceName(option)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.dropdownOptionText,
                    spaceName === option && styles.dropdownOptionTextSelected,
                  ]}
                >
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  section: {
    paddingHorizontal: 20,
    paddingTop: 24,
    marginBottom: 8,
  },
  collapsibleHeader: {
    flex: 1,
    paddingVertical: 12,
    marginBottom: 12,
  },
  collapsibleHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  noDnsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  noDnsLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  collapsibleHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  collapsibleHeaderText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginLeft: 8,
  },
  infoCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDark,
  },
  infoRowLast: {
    borderBottomWidth: 0,
  },
  infoLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    flex: 1,
    marginRight: 12,
  },
  infoValue: {
    fontSize: 14,
    color: colors.text,
    fontWeight: '500',
    flex: 2,
    textAlign: 'right',
  },
  querySubspaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
  },
  queryInputDisabled: {
    opacity: 0.5,
  },
  querySearchButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderDark,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  querySearchButtonDisabled: {
    opacity: 0.5,
  },
  queryResultStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  queryResultStatusText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  queryVerifyErrorText: {
    marginTop: 12,
    fontSize: 14,
    color: colors.error,
  },
  queryVerifyWarningText: {
    marginTop: 12,
    fontSize: 14,
    color: colors.textSecondary,
  },
  queryResultsSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.borderDark,
    paddingTop: 12,
  },
  queryZoneCard: {
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDark,
  },
  queryZoneCardLast: {
    marginBottom: 0,
    paddingBottom: 0,
    borderBottomWidth: 0,
  },
  queryZoneTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 8,
  },
  queryZoneSovereignty: {
    fontWeight: '500',
    color: colors.textSecondary,
  },
  queryZoneMeta: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  queryNoRecords: {
    fontSize: 14,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  queryFallbackHeading: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: 8,
    marginBottom: 4,
  },
  spaceCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  spaceContent: {
    flex: 1,
    marginRight: 12,
  },
  spaceName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  spaceDescription: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  emptyText: {
    fontSize: 16,
    color: colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  findSpacesButton: {
    marginTop: 12,
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  findSpacesButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
  },
  searchCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  atSymbol: {
    fontSize: 24,
    fontWeight: '600',
    color: '#AA4981',
    paddingHorizontal: 0,
    marginHorizontal: -4,
  },
  subspaceInput: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  dropdownButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  dropdownText: {
    fontSize: 14,
    color: colors.text,
  },
  dropdownPlaceholder: {
    color: colors.textSecondary,
  },
  radioGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 8,
  },
  radioButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  radioLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  radioLabelSelected: {
    color: colors.text,
    fontWeight: '500',
  },
  purchaseButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  purchaseButtonDisabled: {
    backgroundColor: colors.card,
    opacity: 0.6,
  },
  purchaseButtonLoading: {
    backgroundColor: colors.card,
  },
  purchaseButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.black,
  },
  purchaseButtonTextDisabled: {
    color: colors.textSecondary,
  },
  cancelButton: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingVertical: 8,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderColor: colors.borderDark,
    borderRadius: 4,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxLabel: {
    fontSize: 14,
    color: colors.text,
    flex: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dropdownContainer: {
    backgroundColor: colors.card,
    borderRadius: 12,
    minWidth: 200,
    maxWidth: '80%',
    paddingVertical: 8,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  dropdownOption: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dropdownOptionSelected: {
    backgroundColor: colors.tintedBackground,
  },
  dropdownOptionText: {
    fontSize: 14,
    color: colors.text,
  },
  dropdownOptionTextSelected: {
    color: colors.primary,
    fontWeight: '600',
  },
  confirmationMessage: {
    backgroundColor: colors.cardDark,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  confirmationText: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
    textAlign: 'center',
  },
  purchaseOrderTable: {
    width: '100%',
  },
  purchaseOrderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 8,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDark,
  },
  purchaseOrderHeaderText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    textTransform: 'uppercase',
  },
  purchaseOrderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  purchaseOrderItemText: {
    fontSize: 14,
    color: colors.text,
    flex: 1,
  },
  purchaseOrderPriceText: {
    fontSize: 14,
    color: colors.text,
    fontWeight: '500',
    textAlign: 'right',
  },
  purchaseOrderTotalRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderDark,
  },
  purchaseOrderTotalText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  purchaseOrderTotalPriceText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'right',
  },
  modalContent: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    width: '90%',
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 16,
    textAlign: 'center',
  },
  txHexContainer: {
    backgroundColor: colors.background,
    borderRadius: 8,
    padding: 12,
    maxHeight: 400,
    marginBottom: 16,
  },
  txHexText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.text,
    lineHeight: 18,
  },
  modalButtonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButtonRowSpacing: {
    marginTop: 12,
  },
  modalCopyButton: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  modalCopyButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  modalDismissButton: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalDismissButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.black,
  },
  modalSimulateButton: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  modalSimulateButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  modalBroadcastButton: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBroadcastButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.black,
  },
  tableContainer: {
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: colors.cardDark,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDark,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  tableHeaderText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    textTransform: 'uppercase',
  },
  /** Space column — share of row width (Status column widened for longer labels). */
  tableHeaderColSpace: {
    flex: 1.8,
    minWidth: 0,
  },
  tableHeaderColStatus: {
    flex: 2.2,
  },
  tableHeaderColCheck: {
    flex: 1,
  },
  tableHeaderStatusButton: {
    justifyContent: 'center',
    minHeight: 20,
  },
  tableHeaderStatusTextDisabled: {
    color: colors.textTertiary,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDark,
    minHeight: 48,
  },
  tableRowLast: {
    borderBottomWidth: 0,
  },
  tableColSpace: {
    flex: 1.8,
    minWidth: 0,
  },
  tableColStatus: {
    flex: 2.2,
  },
  tableColCheck: {
    flex: 1,
  },
  tableCellSpace: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  tableCellSpaceText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.primary,
  },
  tableCellStatus: {
    paddingVertical: 12,
    paddingLeft: 8,
    paddingRight: 8,
    justifyContent: 'center',
  },
  tableCellStatusText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  tableCellNextCheck: {
    paddingVertical: 12,
    paddingLeft: 8,
    paddingRight: 12,
    justifyContent: 'center',
  },
  tableCellNextCheckText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  deleteDialogText: {
    fontSize: 16,
    color: colors.text,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 22,
  },
  modalCancelButton: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  modalCancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  modalDeleteButton: {
    flex: 1,
    backgroundColor: colors.error || '#ef4444',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalDeleteButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white || '#ffffff',
  },
  couponRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  couponInput: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.borderDark,
    letterSpacing: 1,
  },
  couponInputValid: {
    borderColor: '#22c55e',
  },
  couponInputInvalid: {
    borderColor: '#ef4444',
  },
  couponStatusChecking: {
    fontSize: 12,
    color: colors.textSecondary,
    minWidth: 60,
    textAlign: 'right',
  },
  couponStatusValid: {
    fontSize: 13,
    fontWeight: '700',
    color: '#22c55e',
    minWidth: 40,
    textAlign: 'right',
  },
  couponStatusInvalid: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ef4444',
    minWidth: 40,
    textAlign: 'right',
  },
  discountAmountText: {
    color: '#22c55e',
  },
});
