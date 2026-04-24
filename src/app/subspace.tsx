import Header from '@/components/header';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/colors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { toast } from 'sonner-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { AssetTicker, NetworkType, WDKService } from '@tetherto/wdk-react-native-provider';
import { FiatCurrency, pricingService } from '@/services/pricing-service';
import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
} from '@/utils/spaces-scan-paths';
import { WDKSpaces, type UpdateOnchainHexParams } from '@/utils/wdk-spaces';
import {
  conservativePointerPaymentFeeSats,
  extractFeerateSatPerVbFromJson,
} from '@/utils/pointer-payment-fee';
import { requestPurchaseStatusPoll } from '@/utils/purchase-poll-bridge';

const SPACES_API_BASE_URL =
  process.env.EXPO_PUBLIC_SPACES_API_BASE_URL || 'http://192.168.1.111:7264';

const SPACES_APP_NAME = 'spaces-wallet';

const FUNDING_BTC_ACCOUNT_INDEX = Number.parseInt(
  process.env.EXPO_PUBLIC_SPACES_FUNDING_BTC_ACCOUNT_INDEX ?? '0',
  10
);

function extractTxidFromListnumsEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const o = entry as Record<string, unknown>;
  for (const k of ['txid', 'tx_id', 'tx_hash', 'hash', 'transaction_id']) {
    const v = o[k];
    if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) {
      return v.toLowerCase();
    }
  }
  return undefined;
}

type MySpaceRow = {
  subspace: string;
  spaceName: string;
  handle?: string;
  status?:
    | 'purchasing'
    | 'purchased'
    | 'pending'
    | 'pending_payment'
    | 'processing'
    | 'confirmed'
    | 'expired'
    | 'cancelled'
    | string;
  jobId?: number;
  /** Must match `pollJobStatus` unified API when resuming on My Spaces. */
  unifiedStatusPurchaseType?: 'subname' | 'pointer';
  scriptPubKeyHex?: string;
  chainPresence?: 'on-chain' | 'off-chain';
  listnumsLastDataHex?: string;
  /** Tx that created the latest on-chain num (from listnums) — required to spend the 1077-sat output. */
  priorTxid?: string;
  newDataHex?: string;
};

/** RPC-derived presence from GET /api/listnums-by-spk (distinct from purchase `status`). */
export type ChainPresence = 'on-chain' | 'off-chain';

/** Matches `UnifiedStatus` in spaces.tsx — if `status` is in this set, the row is not "Unknown". */
const KNOWN_PURCHASE_STATUSES = new Set<string>([
  'pending_payment',
  'processing',
  'confirmed',
  'proof_created',
  'proof_batched',
  'proof_committed',
  'certificate_pending',
  'certificate_delivered',
  'sptr_creating',
  'sptr_created',
  'sptr_delivered',
  'expired',
  'cancelled',
  'purchasing',
  'requesting',
  'discovered',
  'pending',
  'purchased',
]);

async function fetchListnumsBySpk(scriptPubkeyHex: string): Promise<{ nums: unknown[] }> {
  const url = `${SPACES_API_BASE_URL}/api/listnums-by-spk?script_pubkey=${encodeURIComponent(scriptPubkeyHex)}`;
  console.log('[Subspace] listnums-by-spk — GET', url);
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
  console.log('[Subspace] listnums-by-spk — response', {
    ok: res.ok,
    status: res.status,
    numsLength: nums.length,
    body: body ?? text,
  });
  if (!res.ok) {
    throw new Error(`listnums-by-spk failed (${res.status})`);
  }
  return { nums };
}

type UpdateOnchainStep = 'intro' | 'quoting' | 'confirm' | 'broadcasting';

type TakeOnchainModalStep = 'intro' | 'loading' | 'quote' | 'sending';

type SptrPriceQuote = {
  sptrPriceSats: number;
  /** Wallet network fee estimate for the memo spend (satoshis). */
  estimatedFeeSats: number;
  /** Approx. wallet debit: `postTotalPriceSats` + `estimatedFeeSats`. */
  totalSats: number;
  nextReceiveAddress: string;
  /** Platform `block_fee` sent on POST `purchase_type: "pointer"` (satoshis). */
  blockFeeSats: number;
  /** Amount to pay to `nextReceiveAddress` per server (satoshis). */
  postTotalPriceSats: number;
  /** Pointer purchase created at quote time (Proceed); Pay only broadcasts. */
  pointerPurchase: Record<string, unknown>;
};

/** @see PURCHASE.md — `payment_watch` / pointer watch specs on POST /spaces/... */
type PointerPaymentWatchSpec = {
  method?: string;
  path: string;
  body?: Record<string, unknown>;
};

const POINTER_PURCHASE_CONF_TARGET = 1;

/** Fallback when GET /spaces quote lacks block_fee: PURCHASE.md commitment sizing. */
const POINTER_PURCHASE_BLOCK_FEE_FALLBACK_VBYTES = 256;

function parseNumSats(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function purchaseIdFromRecord(d: Record<string, unknown>): number | undefined {
  const v = d.purchase_id ?? d.purchaseId;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function jobIdFromPurchaseRecord(d: Record<string, unknown>): number | undefined {
  const v = d.job_id ?? d.jobId;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** SPTR / pointer line price (sats) from GET /spaces/:space/:subspace?format=json */
function pointerPriceSatsFromSpacesQuote(data: Record<string, unknown>): number {
  return parseNumSats(
    data.sptr_price ?? data.sptr_price_sats ?? data.pointer_price ?? data.sptrPriceSats
  );
}

async function fetchSpacesQuoteJsonOnce(
  baseUrl: string,
  spaceLower: string,
  subspaceTrimmed: string
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; retryable: boolean; status: number; body: string }
> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/spaces/${encodeURIComponent(spaceLower)}/${encodeURIComponent(subspaceTrimmed)}?app=${SPACES_APP_NAME}&format=json`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      return { ok: false, retryable, status: res.status, body: text.slice(0, 500) };
    }
    try {
      const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      return { ok: true, data };
    } catch {
      return { ok: false, retryable: false, status: res.status, body: text.slice(0, 200) };
    }
  } catch {
    return { ok: false, retryable: true, status: 0, body: 'network error' };
  }
}

/** PURCHASE.md: WDK `sendTransactionWithMemo` → 64-char lowercase txid. */
function transactionIdFromSendResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') {
    const s = result.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(s) ? s : null;
  }
  if (typeof result === 'object' && result !== null && 'hash' in result) {
    const h = (result as { hash?: unknown }).hash;
    if (typeof h === 'string') {
      const s = h.trim().toLowerCase();
      return /^[0-9a-f]{64}$/.test(s) ? s : null;
    }
  }
  return null;
}

function isInsufficientBalanceSendError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const lower = msg.toLowerCase();
  return (
    lower.includes('insufficient balance') ||
    lower.includes('insufficient funds') ||
    lower.includes('not enough funds')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Network errors / 5xx / 408 / 429: back off and retry up to this many attempts. */
const SPACES_API_TRANSIENT_MAX_ATTEMPTS = 3;

type WatchPointerAttemptResult =
  | { ok: true }
  | { ok: false; retryable: boolean; status?: number; detail?: string };

/**
 * PURCHASE.md: POST /api/purchases/watch-pointer-payment-by-handle?space=...
 * Body: { handle, transaction_id } — handle must match ?space= (subname@space).
 */
async function postWatchPointerPaymentByHandleOnce(
  baseUrl: string,
  spaceQuery: string,
  handle: string,
  transactionId: string
): Promise<WatchPointerAttemptResult> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/api/purchases/watch-pointer-payment-by-handle?space=${encodeURIComponent(spaceQuery)}`;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ handle, transaction_id: transactionId }),
    });
    const ms = Date.now() - start;
    const text = await res.text();
    if (res.ok) {
      console.log('[Subspace] watch-pointer-payment-by-handle OK', { ms, body: text || '(empty)' });
      return { ok: true };
    }
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    console.error(
      `[Subspace] watch-pointer-payment-by-handle (${ms}ms)`,
      res.status,
      text?.slice(0, 300) || '(empty)'
    );
    return { ok: false, retryable, status: res.status, detail: text?.slice(0, 200) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Subspace] watch-pointer-payment-by-handle network error', msg);
    return { ok: false, retryable: true, detail: msg };
  }
}

async function postWatchPointerPaymentByHandleWithRetry(
  baseUrl: string,
  spaceQuery: string,
  handle: string,
  transactionId: string
): Promise<{ ok: boolean; exhaustedRetries: boolean }> {
  for (let attempt = 1; attempt <= SPACES_API_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    const r = await postWatchPointerPaymentByHandleOnce(baseUrl, spaceQuery, handle, transactionId);
    if (r.ok) return { ok: true, exhaustedRetries: false };
    if (!r.retryable) {
      console.warn('[Subspace] watch-pointer-payment-by-handle: not retrying (client error)', r);
      return { ok: false, exhaustedRetries: false };
    }
    if (attempt < SPACES_API_TRANSIENT_MAX_ATTEMPTS) {
      const backoffMs = 1000 * (1 << (attempt - 1));
      console.log(
        `[Subspace] watch-pointer-payment-by-handle: retry in ${backoffMs}ms (${attempt}/${SPACES_API_TRANSIENT_MAX_ATTEMPTS})`
      );
      await delay(backoffMs);
    }
  }
  return { ok: false, exhaustedRetries: true };
}

async function postWatchPaymentSpecOnce(
  baseUrl: string,
  spec: PointerPaymentWatchSpec,
  purchaseId: number | undefined,
  transactionId: string
): Promise<WatchPointerAttemptResult> {
  let path = spec.path;
  if (/\{purchase_id\}|\{purchaseId\}/.test(path)) {
    if (purchaseId == null) {
      return { ok: false, retryable: false, detail: 'path requires purchase_id' };
    }
    path = path
      .replace(/\{purchase_id\}/g, String(purchaseId))
      .replace(/\{purchaseId\}/g, String(purchaseId));
  }
  const b = baseUrl.replace(/\/$/, '');
  const url = /^https?:\/\//i.test(path) ? path : `${b}${path.startsWith('/') ? path : `/${path}`}`;
  const method = (spec.method || 'POST').toUpperCase();
  const start = Date.now();
  try {
    const bodyObj = { ...(spec.body ?? {}), transaction_id: transactionId };
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const ms = Date.now() - start;
    const text = await res.text();
    if (res.ok) {
      console.log('[Subspace] payment watch spec OK', { ms, url, body: text?.slice(0, 200) });
      return { ok: true };
    }
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    console.error(`[Subspace] payment watch spec (${ms}ms)`, res.status, text?.slice(0, 300));
    return { ok: false, retryable, status: res.status, detail: text?.slice(0, 200) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Subspace] payment watch spec network error', msg);
    return { ok: false, retryable: true, detail: msg };
  }
}

async function registerPointerPaymentWatchFromPostResponse(
  baseUrl: string,
  spaceLower: string,
  handle: string,
  purchase: Record<string, unknown>,
  transactionId: string
): Promise<{ ok: boolean; exhaustedRetries: boolean }> {
  const purchaseId = purchaseIdFromRecord(purchase);
  const trySpec = async (spec: unknown): Promise<boolean> => {
    if (
      !spec ||
      typeof spec !== 'object' ||
      typeof (spec as PointerPaymentWatchSpec).path !== 'string'
    ) {
      return false;
    }
    const r = await postWatchPaymentSpecOnce(
      baseUrl,
      spec as PointerPaymentWatchSpec,
      purchaseId,
      transactionId
    );
    return r.ok;
  };

  if (await trySpec(purchase.payment_watch)) {
    return { ok: true, exhaustedRetries: false };
  }
  const pbh = purchase.pointer_watch_by_handle ?? purchase.pointer_payment_watch_by_handle;
  if (await trySpec(pbh)) {
    return { ok: true, exhaustedRetries: false };
  }
  return postWatchPointerPaymentByHandleWithRetry(baseUrl, spaceLower, handle, transactionId);
}

async function postStandalonePointerPurchase(
  baseUrl: string,
  spaceLower: string,
  subspaceKey: string,
  handle: string,
  priceSats: number,
  blockFeeSats: number
): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; status: number; body: string }
> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/spaces/${encodeURIComponent(spaceLower)}/${encodeURIComponent(subspaceKey)}?app=${SPACES_APP_NAME}&format=json`;
  const payload = {
    purchase_type: 'pointer',
    block_fee: blockFeeSats,
    handle,
    price: priceSats,
    conf_target: POINTER_PURCHASE_CONF_TARGET,
  };
  console.log('[Subspace] POST pointer purchase', url, payload);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text };
  }
  try {
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { ok: true, data };
  } catch {
    return { ok: false, status: res.status, body: text || 'invalid JSON' };
  }
}

/**
 * SpacesOps-style platform feerate (e.g. https://spacesops.com/api/estimate-fee?conf_target=1&mode=conservative).
 * Uses SPACES_API_BASE_URL so dev/staging hosts work the same way.
 */
async function fetchFeerateFromPlatformEstimateFee(baseUrl: string): Promise<number | null> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/api/estimate-fee?conf_target=1&mode=conservative`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const r = extractFeerateSatPerVbFromJson(data);
    if (r != null) {
      console.log('[Subspace] feerate from GET /api/estimate-fee:', r, url);
    }
    return r;
  } catch {
    return null;
  }
}

async function resolvePointerBlockFeeSats(
  sptrRaw: Record<string, unknown> | null,
  baseUrl: string,
  spaceLower: string,
  subspaceTrimmed: string
): Promise<number> {
  const o = sptrRaw ?? {};
  for (const k of [
    o.block_fee,
    o['1_block_fee'],
    o.pointer_block_fee,
    o.block_pointer_fee,
    o.platform_block_fee,
  ]) {
    const n = parseNumSats(k);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  try {
    const b = baseUrl.replace(/\/$/, '');
    const url = `${b}/spaces/${encodeURIComponent(spaceLower)}/${encodeURIComponent(subspaceTrimmed)}?app=${SPACES_APP_NAME}&format=json`;
    const res = await fetch(url);
    if (res.ok) {
      const d = (await res.json()) as Record<string, unknown>;
      const bf = parseNumSats(d['1_block_fee'] ?? d.block_fee);
      if (Number.isFinite(bf) && bf >= 0) {
        console.log('[Subspace] pointer block_fee from GET /spaces quote:', bf);
        return Math.trunc(bf);
      }
    }
  } catch {
    /* fall through */
  }
  const feerate = await fetchFeerateFromPlatformEstimateFee(baseUrl);
  if (feerate != null) {
    const fallback = Math.ceil(POINTER_PURCHASE_BLOCK_FEE_FALLBACK_VBYTES * feerate * 1.15);
    console.warn('[Subspace] pointer block_fee from feerate fallback:', fallback);
    return Math.max(1, fallback);
  }
  return 0;
}

async function fetchFeerateFromSpacesQuote(
  baseUrl: string,
  spaceNameLower: string,
  subspaceTrimmed: string
): Promise<number | null> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/spaces/${encodeURIComponent(spaceNameLower)}/${encodeURIComponent(subspaceTrimmed)}?app=${SPACES_APP_NAME}&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const r = extractFeerateSatPerVbFromJson(data);
    if (r != null) {
      console.log('[Subspace] feerate from GET /spaces quote:', r, url);
    }
    return r;
  } catch {
    return null;
  }
}

async function fetchFeerateFromTenantEstimateFee(
  baseUrl: string,
  spaceNameLower: string
): Promise<number | null> {
  const b = baseUrl.replace(/\/$/, '');
  const candidates = [
    `${b}/api/tenants/${encodeURIComponent(spaceNameLower)}/estimatefee?blocks=1`,
    `${b}/api/tenants/${encodeURIComponent(spaceNameLower)}/estimatefee?conf_target=1`,
    `${b}/api/estimatefee?space=${encodeURIComponent(spaceNameLower)}&blocks=1`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        continue;
      }
      const r = extractFeerateSatPerVbFromJson(data);
      if (r != null) {
        console.log('[Subspace] feerate from tenant estimatefee:', r, url);
        return r;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function resolvePointerPaymentFeerateSatPerVb(
  baseUrl: string,
  spaceNameLower: string,
  subspaceTrimmed: string,
  sptrPriceBody: unknown
): Promise<number | null> {
  const fromBody = extractFeerateSatPerVbFromJson(sptrPriceBody);
  if (fromBody != null) {
    console.log('[Subspace] feerate from quote JSON:', fromBody);
    return fromBody;
  }
  const fromPlatform = await fetchFeerateFromPlatformEstimateFee(baseUrl);
  if (fromPlatform != null) return fromPlatform;
  const fromQuote = await fetchFeerateFromSpacesQuote(baseUrl, spaceNameLower, subspaceTrimmed);
  if (fromQuote != null) return fromQuote;
  return fetchFeerateFromTenantEstimateFee(baseUrl, spaceNameLower);
}

async function fiatLabelForFeeSats(feeSats: number): Promise<string | null> {
  try {
    if (!pricingService.isReady()) {
      await pricingService.initialize();
    }
    let rate = pricingService.getExchangeRate(AssetTicker.BTC, FiatCurrency.USD);
    if (rate == null || rate === 0) {
      await pricingService.refreshExchangeRates();
      rate = pricingService.getExchangeRate(AssetTicker.BTC, FiatCurrency.USD);
    }
    const btc = feeSats / 100_000_000;
    const usd = await pricingService.getFiatValue(btc, AssetTicker.BTC, FiatCurrency.USD);
    if (!Number.isFinite(usd)) return null;
    return usd.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return null;
  }
}

/** Match `scriptPubKeyHex` to a Spaces scan path and return taproot receive address + wallet-relative path for `priorAcct`. */
/** P2TR scriptPubKey: OP_1 (0x51) + push 32 (0x20) + 32-byte x-only output key. */
function taprootXOnlyPubkeyHexFromScriptPubkeyHex(scriptPubkeyHex: string): string | null {
  const h = scriptPubkeyHex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/i.test(h) || h.length < 68) return null;
  if (!h.startsWith('5120')) return null;
  return h.slice(4, 68);
}

async function resolveTaprootForScriptPubKey(scriptPubKeyHex: string): Promise<{
  address: string;
  priorAccountRelativePath: string;
  /** Full BIP-86 path, e.g. m/86'/0'/9'/0/0 */
  derivationPath: string;
} | null> {
  const { bip, coinType } = getBitcoinTaprootPathPrefix();
  const fullPaths = buildSpacesScanDerivationPaths();
  const rels: string[] = [];
  for (const p of fullPaths) {
    const rel = fullPathToWalletRelativePath(p, bip, coinType);
    if (rel) rels.push(rel);
  }
  if (rels.length === 0) return null;
  const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths(rels);
  const entries = JSON.parse(addressesJson) as { address?: string; scriptPubKeyHex?: string }[];
  const target = scriptPubKeyHex.toLowerCase();
  const idx = entries.findIndex((e) => e.scriptPubKeyHex?.toLowerCase() === target);
  if (idx < 0 || !entries[idx]?.address) return null;
  const derivationPath = fullPaths[idx] ?? `m/${bip}'/${coinType}'/${rels[idx]}`;
  return {
    address: entries[idx].address!,
    priorAccountRelativePath: rels[idx],
    derivationPath,
  };
}

export default function SubspaceScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const {
    subspace,
    spaceName,
    scriptPubKeyHex: scriptPubKeyHexParam,
  } = useLocalSearchParams<{
    subspace: string;
    spaceName: string;
    scriptPubKeyHex?: string;
  }>();

  const [spaceData, setSpaceData] = useState<MySpaceRow | null>(null);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [showTakeOnchainDialog, setShowTakeOnchainDialog] = useState(false);
  const [takeOnchainStep, setTakeOnchainStep] = useState<TakeOnchainModalStep>('intro');
  const [sptrQuote, setSptrQuote] = useState<SptrPriceQuote | null>(null);
  const [showUpdateOnchainModal, setShowUpdateOnchainModal] = useState(false);
  const [chainResolutionLoading, setChainResolutionLoading] = useState(false);
  const [updateOnchainStep, setUpdateOnchainStep] = useState<UpdateOnchainStep>('intro');
  const [quotedFeeSats, setQuotedFeeSats] = useState<number | null>(null);
  const [quotedUsdLabel, setQuotedUsdLabel] = useState<string | null>(null);
  const [broadcastParams, setBroadcastParams] = useState<UpdateOnchainHexParams | null>(null);
  const [receiveCertificateLoading, setReceiveCertificateLoading] = useState(false);
  const [hasStoredCertificate, setHasStoredCertificate] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const certificateStorageKey = useMemo(() => {
    if (!subspace?.trim() || !spaceName) {
      return null;
    }
    return `spaces_cert_${spaceName.toLowerCase()}_${subspace.trim()}`;
  }, [subspace, spaceName]);

  const takeOnchainDialogVisibleRef = useRef(false);
  useEffect(() => {
    takeOnchainDialogVisibleRef.current = showTakeOnchainDialog;
  }, [showTakeOnchainDialog]);

  const [taprootReceiveAddress, setTaprootReceiveAddress] = useState<string | null>(null);
  const [taprootDerivationPath, setTaprootDerivationPath] = useState<string | null>(null);
  const [taprootAddressLoading, setTaprootAddressLoading] = useState(false);

  useEffect(() => {
    const spk = spaceData?.scriptPubKeyHex?.trim();
    if (!spk) {
      setTaprootReceiveAddress(null);
      setTaprootDerivationPath(null);
      setTaprootAddressLoading(false);
      return;
    }
    let cancelled = false;
    setTaprootAddressLoading(true);
    resolveTaprootForScriptPubKey(spk)
      .then((r) => {
        if (!cancelled) {
          setTaprootReceiveAddress(r?.address ?? null);
          setTaprootDerivationPath(r?.derivationPath ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTaprootReceiveAddress(null);
          setTaprootDerivationPath(null);
        }
      })
      .finally(() => {
        if (!cancelled) setTaprootAddressLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceData?.scriptPubKeyHex]);

  useEffect(() => {
    if (showUpdateOnchainModal) {
      setUpdateOnchainStep('intro');
      setQuotedFeeSats(null);
      setQuotedUsdLabel(null);
      setBroadcastParams(null);
    }
  }, [showUpdateOnchainModal]);

  useEffect(() => {
    if (!showTakeOnchainDialog) {
      setTakeOnchainStep('intro');
      setSptrQuote(null);
    }
  }, [showTakeOnchainDialog]);

  const refreshStoredCertificateFlag = useCallback(async () => {
    if (!certificateStorageKey) {
      setHasStoredCertificate(false);
      return;
    }
    try {
      const v = await AsyncStorage.getItem(certificateStorageKey);
      setHasStoredCertificate(Boolean(v?.trim()));
    } catch {
      setHasStoredCertificate(false);
    }
  }, [certificateStorageKey]);

  useEffect(() => {
    void refreshStoredCertificateFlag();
  }, [refreshStoredCertificateFlag]);

  useFocusEffect(
    useCallback(() => {
      void refreshStoredCertificateFlag();
    }, [refreshStoredCertificateFlag])
  );

  // Load space data from AsyncStorage
  useEffect(() => {
    const loadSpaceData = async () => {
      if (!subspace || !spaceName) return;

      try {
        const stored = await AsyncStorage.getItem('mySpaces');
        if (stored) {
          const loadedSpaces = JSON.parse(stored) as MySpaceRow[];
          const space = loadedSpaces.find(
            (s) => s.subspace === subspace && s.spaceName === spaceName.toLowerCase()
          );
          if (space) {
            setSpaceData({
              subspace: space.subspace,
              spaceName: space.spaceName,
              handle: space.handle,
              status: space.status,
              jobId: space.jobId,
              unifiedStatusPurchaseType: space.unifiedStatusPurchaseType,
              scriptPubKeyHex: space.scriptPubKeyHex ?? scriptPubKeyHexParam,
              chainPresence: space.chainPresence,
              listnumsLastDataHex: space.listnumsLastDataHex,
              priorTxid: space.priorTxid,
              newDataHex: space.newDataHex,
            });
          } else if (scriptPubKeyHexParam) {
            setSpaceData({
              subspace,
              spaceName: spaceName.toLowerCase(),
              scriptPubKeyHex: scriptPubKeyHexParam,
            });
          }
        } else if (scriptPubKeyHexParam) {
          setSpaceData({
            subspace,
            spaceName: spaceName.toLowerCase(),
            scriptPubKeyHex: scriptPubKeyHexParam,
          });
        }
      } catch (error) {
        console.error('[Subspace] Failed to load space data:', error);
      }
    };

    loadSpaceData();
  }, [subspace, spaceName, scriptPubKeyHexParam]);

  useFocusEffect(
    useCallback(() => {
      if (!subspace || !spaceName) return;
      (async () => {
        try {
          const stored = await AsyncStorage.getItem('mySpaces');
          if (!stored) return;
          const loadedSpaces = JSON.parse(stored) as MySpaceRow[];
          const space = loadedSpaces.find(
            (s) => s.subspace === subspace && s.spaceName === spaceName.toLowerCase()
          );
          if (space) {
            setSpaceData((prev) =>
              prev
                ? {
                    ...prev,
                    handle: space.handle ?? prev.handle,
                    scriptPubKeyHex:
                      space.scriptPubKeyHex ?? prev.scriptPubKeyHex ?? scriptPubKeyHexParam,
                    chainPresence: space.chainPresence ?? prev.chainPresence,
                    listnumsLastDataHex: space.listnumsLastDataHex ?? prev.listnumsLastDataHex,
                    priorTxid: space.priorTxid ?? prev.priorTxid,
                    newDataHex: space.newDataHex ?? prev.newDataHex,
                    status: space.status ?? prev.status,
                    jobId: space.jobId ?? prev.jobId,
                    unifiedStatusPurchaseType:
                      space.unifiedStatusPurchaseType ?? prev.unifiedStatusPurchaseType,
                  }
                : {
                    subspace: space.subspace,
                    spaceName: space.spaceName,
                    handle: space.handle,
                    status: space.status,
                    jobId: space.jobId,
                    unifiedStatusPurchaseType: space.unifiedStatusPurchaseType,
                    scriptPubKeyHex: space.scriptPubKeyHex ?? scriptPubKeyHexParam,
                    chainPresence: space.chainPresence,
                    listnumsLastDataHex: space.listnumsLastDataHex,
                    priorTxid: space.priorTxid,
                    newDataHex: space.newDataHex,
                  }
            );
          }
        } catch (e) {
          console.error('[Subspace] focus reload:', e);
        }
      })();
    }, [subspace, spaceName, scriptPubKeyHexParam])
  );

  /** True when we should call listnums-by-spk: missing/unknown status, or Discovered from Find Spaces. */
  const shouldRunListnumsResolution = (row: MySpaceRow | null): boolean => {
    if (!row) return false;
    // Certificate phase: need script pub key / listnums for the same detail UI as on-chain (and Hex Tool data).
    if (row.status === 'certificate_pending' || row.status === 'certificate_delivered') {
      if (!row.scriptPubKeyHex?.trim() || !row.chainPresence) {
        return true;
      }
    }
    if (row.chainPresence) return false;
    if (row.status === 'discovered') return true;
    if (!row.status) return true;
    return !KNOWN_PURCHASE_STATUSES.has(row.status);
  };

  /**
   * Resolves script pubkey: route param / stored row, or derive all BIP-86 paths from
   * `buildSpacesScanDerivationPaths()` and pick the on-chain one (listnums) when multiple indices.
   */
  async function resolveSpkAndListnumsForSubspace(
    row: MySpaceRow
  ): Promise<{ spk: string; nums: unknown[] } | null> {
    const fromParamOrStore = scriptPubKeyHexParam || row.scriptPubKeyHex;
    if (fromParamOrStore?.trim()) {
      try {
        const { nums } = await fetchListnumsBySpk(fromParamOrStore.trim());
        return { spk: fromParamOrStore.trim(), nums };
      } catch (e) {
        console.error('[Subspace] listnums-by-spk (stored spk) failed:', e);
        return null;
      }
    }

    const fullPaths = buildSpacesScanDerivationPaths();
    if (fullPaths.length === 0) {
      console.warn(
        '[Subspace] No scan paths — set EXPO_PUBLIC_SPACES_ACCOUNT_NUMBER / EXPO_PUBLIC_SPACES_ACCOUNT_GAP in .env'
      );
      return null;
    }
    const { bip, coinType } = getBitcoinTaprootPathPrefix();
    const rels: string[] = [];
    for (const p of fullPaths) {
      const rel = fullPathToWalletRelativePath(p, bip, coinType);
      if (rel) {
        rels.push(rel);
      }
    }
    if (rels.length === 0) {
      return null;
    }
    let entries: { scriptPubKeyHex?: string }[];
    try {
      const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths(rels);
      entries = JSON.parse(addressesJson) as { scriptPubKeyHex?: string }[];
    } catch (e) {
      console.error('[Subspace] deriveTaprootAddressesFromPaths failed:', e);
      return null;
    }
    const spks = entries
      .map((e) => e.scriptPubKeyHex)
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
    if (spks.length === 0) {
      return null;
    }

    if (spks.length === 1) {
      try {
        const { nums } = await fetchListnumsBySpk(spks[0]);
        return { spk: spks[0], nums };
      } catch (e) {
        console.error('[Subspace] listnums-by-spk (single derived spk) failed:', e);
        return null;
      }
    }

    const listnumsResults = await Promise.all(
      spks.map(async (h) => {
        try {
          const { nums } = await fetchListnumsBySpk(h);
          return { h, nums } as const;
        } catch {
          return { h, nums: [] as unknown[] } as const;
        }
      })
    );
    for (const { h, nums } of listnumsResults) {
      if (nums.length > 0) {
        return { spk: h, nums };
      }
    }
    // All off-chain: use first path’s listnums result (already fetched above).
    return { spk: spks[0], nums: listnumsResults[0].nums };
  }

  useEffect(() => {
    if (!subspace || !spaceName || !spaceData) return;
    if (!shouldRunListnumsResolution(spaceData)) return;

    let cancelled = false;
    (async () => {
      setChainResolutionLoading(true);
      try {
        const resolved = await resolveSpkAndListnumsForSubspace(spaceData);
        if (cancelled || !resolved) {
          if (!resolved) {
            toast.error(
              'Could not derive script pubkey from wallet paths or load listnums. Check .env and network.'
            );
          }
          return;
        }
        const { spk, nums } = resolved;
        if (cancelled) return;

        const chainPresence: ChainPresence = nums.length > 0 ? 'on-chain' : 'off-chain';
        let listnumsLastDataHex: string | undefined;
        let priorTxid: string | undefined;
        if (nums.length > 0) {
          const last = nums[nums.length - 1];
          if (last && typeof last === 'object' && 'data' in last) {
            const d = (last as { data?: unknown }).data;
            listnumsLastDataHex = typeof d === 'string' ? d : undefined;
          }
          priorTxid = extractTxidFromListnumsEntry(last);
        }

        const stored = await AsyncStorage.getItem('mySpaces');
        if (stored) {
          const loadedSpaces = JSON.parse(stored) as MySpaceRow[];
          const updated = loadedSpaces.map((s) =>
            s.subspace === subspace && s.spaceName === spaceName.toLowerCase()
              ? {
                  ...s,
                  scriptPubKeyHex: spk,
                  chainPresence,
                  listnumsLastDataHex,
                  priorTxid,
                }
              : s
          );
          await AsyncStorage.setItem('mySpaces', JSON.stringify(updated));
        }

        if (!cancelled) {
          setSpaceData((prev) =>
            prev
              ? {
                  ...prev,
                  scriptPubKeyHex: spk,
                  chainPresence,
                  listnumsLastDataHex,
                  priorTxid,
                }
              : prev
          );
        }
      } catch (e) {
        console.error('[Subspace] listnums-by-spk:', e);
        toast.error(e instanceof Error ? e.message : 'Chain status check failed');
      } finally {
        setChainResolutionLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subspace, spaceName, spaceData]);

  const handleReceiveCertificate = useCallback(async () => {
    if (!subspace?.trim() || !spaceName || !certificateStorageKey) {
      toast.error('Missing subspace or space name');
      return;
    }
    const hadExisting = hasStoredCertificate;
    setReceiveCertificateLoading(true);
    try {
      const space = encodeURIComponent(spaceName.toLowerCase());
      const sub = encodeURIComponent(subspace.trim());
      const url = `${SPACES_API_BASE_URL}/api/subsd/spaces/${space}/${sub}/cert.json`;
      console.log('[Subspace] GET certificate', url);
      const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Certificate could not be loaded (${res.status})`);
      }
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new Error('Certificate response is not valid JSON');
      }
      const payload = {
        receivedAt: Date.now(),
        url,
        certificate: data,
      };
      await AsyncStorage.setItem(certificateStorageKey, JSON.stringify(payload));
      setHasStoredCertificate(true);
      toast.success(
        hadExisting ? 'Latest certificate saved on this device' : 'Certificate saved on this device'
      );
    } catch (e) {
      console.error('[Subspace] receive certificate', e);
      toast.error(e instanceof Error ? e.message : 'Failed to download certificate');
    } finally {
      setReceiveCertificateLoading(false);
    }
  }, [subspace, spaceName, certificateStorageKey, hasStoredCertificate]);

  const handleDeletePress = () => {
    setShowDeleteConfirmation(true);
  };

  const handleCancelDelete = () => {
    setShowDeleteConfirmation(false);
  };

  const handleConfirmDelete = async () => {
    if (!spaceData) return;

    const { subspace: spaceSubspace, spaceName: spaceSpaceName } = spaceData;

    // Remove from AsyncStorage
    try {
      const stored = await AsyncStorage.getItem('mySpaces');
      if (stored) {
        const loadedSpaces = JSON.parse(stored);
        const filtered = loadedSpaces.filter(
          (s: { subspace: string; spaceName: string }) =>
            !(s.subspace === spaceSubspace && s.spaceName === spaceSpaceName)
        );
        await AsyncStorage.setItem('mySpaces', JSON.stringify(filtered));
        console.log(
          '[Subspace] Removed space from AsyncStorage:',
          spaceSubspace,
          '@',
          spaceSpaceName
        );
      }
    } catch (error) {
      console.error('[Subspace] Failed to remove space from AsyncStorage:', error);
      Alert.alert('Error', 'Failed to delete space');
      return;
    }

    // Close confirmation dialog
    setShowDeleteConfirmation(false);

    // Show success message
    toast.success(`Removed ${spaceSubspace}@${spaceSpaceName}`);

    // Navigate back to spaces page
    router.back();
  };

  if (!subspace || !spaceName) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Header title="Spaces" />
        <View style={styles.content}>
          <Text style={styles.errorText}>Invalid space</Text>
        </View>
      </View>
    );
  }

  const displayName = `${subspace}@${spaceName}`;

  // Get formatted status (chain presence from listnums takes precedence over purchase status,
  // except certificate phases so "Preparing Certificate" / "Certificate Ready" still show with on-chain data)
  const getStatusText = (): string => {
    if (spaceData?.status === 'certificate_pending') return 'Preparing Certificate';
    if (spaceData?.status === 'certificate_delivered') return 'Certificate Ready';
    if (spaceData?.chainPresence === 'on-chain') return 'On-chain';
    if (spaceData?.chainPresence === 'off-chain') return 'Off-chain';
    if (!spaceData?.status) return 'Unknown';

    const statusMap: Record<string, string> = {
      pending_payment: 'Awaiting Payment',
      processing: 'Confirming Payment',
      confirmed: 'Payment Confirmed',
      proof_created: 'Proof Created',
      proof_batched: 'Waiting for Batch',
      proof_committed: 'Proof Committed',
      certificate_pending: 'Preparing Certificate',
      certificate_delivered: 'Certificate Ready',
      sptr_creating: 'Creating SPTR',
      sptr_created: 'SPTR Created',
      sptr_delivered: 'Complete',
      expired: 'Expired',
      cancelled: 'Cancelled',
      purchasing: 'Purchasing',
      requesting: 'Requesting',
      discovered: 'Discovered',
      pending: 'Pending',
      purchased: 'Purchased',
    };

    return statusMap[spaceData.status] || 'Unknown';
  };

  /** Hex Tool after chain check: disabled while loading or when listnums says off-chain. */
  const isHexToolEnabled =
    Boolean(spaceData) && !chainResolutionLoading && spaceData?.chainPresence !== 'off-chain';

  const showTakeOnchainButton = spaceData?.chainPresence === 'off-chain';

  const hasPendingOnchainUpdate = Boolean(
    spaceData?.newDataHex && spaceData.newDataHex.trim().length > 0
  );

  const validateOnchainUpdatePrereqs = (): string | null => {
    if (!spaceData?.newDataHex?.trim()) return 'No wire payload — use Hex Tool first';
    if (!spaceData.scriptPubKeyHex) {
      return 'Missing script pubkey — wait for chain check or set EXPO_PUBLIC_SPACES_ACCOUNT_GAP=1';
    }
    if (!spaceData.priorTxid) {
      return 'Missing prior transaction id (listnums must include a txid for the latest num).';
    }
    return null;
  };

  const handleQuoteOnchainUpdate = async () => {
    const err = validateOnchainUpdatePrereqs();
    if (err) {
      toast.error(err);
      return;
    }
    setUpdateOnchainStep('quoting');
    try {
      const dest = await resolveTaprootForScriptPubKey(spaceData!.scriptPubKeyHex!);
      if (!dest) {
        toast.error('Script pubkey does not match any configured Spaces scan path');
        setUpdateOnchainStep('intro');
        return;
      }
      const fundingIdx = Number.isFinite(FUNDING_BTC_ACCOUNT_INDEX) ? FUNDING_BTC_ACCOUNT_INDEX : 0;
      const params: UpdateOnchainHexParams = {
        network: 'bitcoin',
        fundingAccountIndex: fundingIdx,
        options: {
          to: dest.address,
          hex: spaceData!.newDataHex!.trim(),
          priorTx: spaceData!.priorTxid!,
          priorAccountRelativePath: dest.priorAccountRelativePath,
          confirmationTarget: 1,
        },
      };
      const { txHex, fee } = await WDKSpaces.quoteUpdateTransactionWithHexTX(params);
      console.log('[Subspace] quoteUpdateTransactionWithHexTX:', txHex);
      const feeNum = fee != null && fee !== '' ? Number(fee) : NaN;
      const sats = Number.isFinite(feeNum) ? Math.max(0, Math.round(feeNum)) : null;
      setQuotedFeeSats(sats);
      setQuotedUsdLabel(sats != null ? await fiatLabelForFeeSats(sats) : null);
      setBroadcastParams(params);
      setUpdateOnchainStep('confirm');
    } catch (e) {
      console.error('[Subspace] quoteUpdateTransactionWithHexTX:', e);
      toast.error(e instanceof Error ? e.message : 'Quote failed');
      setUpdateOnchainStep('intro');
    }
  };

  const handleConfirmOnchainBroadcast = async () => {
    if (!broadcastParams) {
      toast.error('Missing transaction parameters — try again');
      setUpdateOnchainStep('intro');
      return;
    }
    setUpdateOnchainStep('broadcasting');
    try {
      const { hash, fee } = await WDKSpaces.updateTransactionWithHex(broadcastParams);
      console.log('[Subspace] updateTransactionWithHex — txid:', hash, 'fee:', fee);
      setShowUpdateOnchainModal(false);
      Alert.alert('Transaction sent', `Transaction ID:\n${hash}`, [{ text: 'OK' }]);
      toast.success(`Transaction broadcast — ${hash.slice(0, 16)}…`);
    } catch (e) {
      console.error('[Subspace] updateTransactionWithHex:', e);
      toast.error(e instanceof Error ? e.message : 'Broadcast failed');
      setUpdateOnchainStep('confirm');
    }
  };

  const handleTakeOnchainProceed = async () => {
    setTakeOnchainStep('loading');
    const subspaceKey = subspace.trim();
    const spaceLower = spaceName.toLowerCase();
    const handleForPurchase = `${subspaceKey}@${spaceLower}`;
    console.log('[Subspace] Take on-chain quote — GET /spaces + POST pointer purchase');
    try {
      let spacesData: Record<string, unknown> | null = null;
      for (let attempt = 1; attempt <= SPACES_API_TRANSIENT_MAX_ATTEMPTS; attempt++) {
        const r = await fetchSpacesQuoteJsonOnce(SPACES_API_BASE_URL, spaceLower, subspaceKey);
        if (r.ok) {
          spacesData = r.data;
          break;
        }
        if (!r.retryable) {
          toast.error(`Could not load space quote (${r.status}). ${r.body.slice(0, 160)}`);
          setTakeOnchainStep('intro');
          return;
        }
        if (attempt < SPACES_API_TRANSIENT_MAX_ATTEMPTS) {
          const backoffMs = 1000 * (1 << (attempt - 1));
          console.log(
            `[Subspace] GET /spaces quote: retry in ${backoffMs}ms (${attempt}/${SPACES_API_TRANSIENT_MAX_ATTEMPTS})`
          );
          await delay(backoffMs);
        } else {
          Alert.alert(
            'Quote unavailable',
            `The Spaces server did not return a quote after ${SPACES_API_TRANSIENT_MAX_ATTEMPTS} attempts. Check your connection and try again.`,
            [{ text: 'OK' }]
          );
          setTakeOnchainStep('intro');
          return;
        }
      }
      if (!spacesData) {
        setTakeOnchainStep('intro');
        return;
      }

      const sptrPriceSats = pointerPriceSatsFromSpacesQuote(spacesData);
      if (!Number.isFinite(sptrPriceSats) || sptrPriceSats <= 0) {
        toast.error(
          'Pointer (SPTR) price is not available from the space quote. Open Find & Purchase or check the handle on the server.'
        );
        setTakeOnchainStep('intro');
        return;
      }

      const blockFeeSats = await resolvePointerBlockFeeSats(
        spacesData,
        SPACES_API_BASE_URL,
        spaceLower,
        subspaceKey
      );
      if (blockFeeSats <= 0) {
        toast.error('Could not resolve platform block fee for pointer purchase.');
        setTakeOnchainStep('intro');
        return;
      }

      let created:
        | { ok: true; data: Record<string, unknown> }
        | { ok: false; status: number; body: string }
        | null = null;
      for (let attempt = 1; attempt <= SPACES_API_TRANSIENT_MAX_ATTEMPTS; attempt++) {
        created = await postStandalonePointerPurchase(
          SPACES_API_BASE_URL,
          spaceLower,
          subspaceKey,
          handleForPurchase,
          sptrPriceSats,
          blockFeeSats
        );
        if (created.ok) break;
        const retryable = created.status >= 500 || created.status === 408 || created.status === 429;
        if (!retryable) {
          toast.error(`Pointer purchase failed (${created.status}): ${created.body.slice(0, 220)}`);
          setTakeOnchainStep('intro');
          return;
        }
        if (attempt < SPACES_API_TRANSIENT_MAX_ATTEMPTS) {
          const backoffMs = 1000 * (1 << (attempt - 1));
          console.log(
            `[Subspace] POST pointer purchase: retry in ${backoffMs}ms (${attempt}/${SPACES_API_TRANSIENT_MAX_ATTEMPTS})`
          );
          await delay(backoffMs);
        } else {
          toast.error('Pointer purchase failed after retries.');
          setTakeOnchainStep('intro');
          return;
        }
      }
      if (!created?.ok) {
        setTakeOnchainStep('intro');
        return;
      }

      const purchase = created.data;
      const taprootAddress =
        typeof purchase.taproot_address === 'string' ? purchase.taproot_address.trim() : '';
      const postTotalPriceSats = parseNumSats(purchase.total_price);
      if (!taprootAddress || !Number.isFinite(postTotalPriceSats) || postTotalPriceSats <= 0) {
        toast.error('Invalid pointer purchase response from server.');
        setTakeOnchainStep('intro');
        return;
      }

      const jobIdResolved = jobIdFromPurchaseRecord(purchase);
      if (jobIdResolved != null) {
        try {
          const stored = await AsyncStorage.getItem('mySpaces');
          const handleStr = handleForPurchase;
          if (stored) {
            const loaded = JSON.parse(stored) as MySpaceRow[];
            let found = false;
            const updated = loaded.map((s) => {
              if (s.subspace === subspaceKey && s.spaceName === spaceLower) {
                found = true;
                return {
                  ...s,
                  jobId: jobIdResolved,
                  handle: s.handle ?? handleStr,
                  unifiedStatusPurchaseType: 'pointer' as const,
                  status: 'pending_payment',
                };
              }
              return s;
            });
            if (!found) {
              updated.push({
                subspace: subspaceKey,
                spaceName: spaceLower,
                handle: handleStr,
                status: 'pending_payment',
                jobId: jobIdResolved,
                unifiedStatusPurchaseType: 'pointer',
              });
            }
            await AsyncStorage.setItem('mySpaces', JSON.stringify(updated));
          } else {
            await AsyncStorage.setItem(
              'mySpaces',
              JSON.stringify([
                {
                  subspace: subspaceKey,
                  spaceName: spaceLower,
                  handle: handleStr,
                  status: 'pending_payment',
                  jobId: jobIdResolved,
                  unifiedStatusPurchaseType: 'pointer',
                },
              ])
            );
          }
        } catch (e) {
          console.warn('[Subspace] could not persist pointer job to mySpaces', e);
        }
        setSpaceData((prev) => {
          if (prev && prev.subspace === subspaceKey && prev.spaceName === spaceLower) {
            return {
              ...prev,
              jobId: jobIdResolved,
              unifiedStatusPurchaseType: 'pointer',
              status: 'pending_payment',
            };
          }
          if (!prev) {
            return {
              subspace: subspaceKey,
              spaceName: spaceLower,
              jobId: jobIdResolved,
              unifiedStatusPurchaseType: 'pointer',
              status: 'pending_payment',
              scriptPubKeyHex: scriptPubKeyHexParam,
            };
          }
          return prev;
        });
      }

      let feerate = await resolvePointerPaymentFeerateSatPerVb(
        SPACES_API_BASE_URL,
        spaceLower,
        subspaceKey,
        spacesData
      );
      if (feerate == null) {
        feerate = await fetchFeerateFromPlatformEstimateFee(SPACES_API_BASE_URL);
      }
      const walletFeeSats = feerate != null ? conservativePointerPaymentFeeSats(feerate) : 800;

      const quote: SptrPriceQuote = {
        sptrPriceSats,
        estimatedFeeSats: walletFeeSats,
        totalSats: postTotalPriceSats + walletFeeSats,
        nextReceiveAddress: taprootAddress,
        blockFeeSats,
        postTotalPriceSats,
        pointerPurchase: purchase,
      };

      if (!takeOnchainDialogVisibleRef.current) return;
      setSptrQuote(quote);
      setTakeOnchainStep('quote');
      console.log('[Subspace] Take on-chain quote (POST pointer purchase)', quote);
    } catch (e) {
      console.error('[Subspace] Take on-chain quote:', e);
      toast.error(e instanceof Error ? e.message : 'Could not load quote');
      if (takeOnchainDialogVisibleRef.current) {
        setTakeOnchainStep('intro');
      }
    }
  };

  const handleTakeOnchainPurchase = async () => {
    if (!sptrQuote) return;
    if (!sptrQuote.pointerPurchase || sptrQuote.postTotalPriceSats <= 0) {
      toast.error('Quote is missing — tap Proceed again to refresh.');
      return;
    }
    if (sptrQuote.blockFeeSats <= 0) {
      toast.error('Missing platform block fee — reopen Take On-chain to refresh.');
      return;
    }
    setTakeOnchainStep('sending');
    const subspaceKey = subspace.trim();
    const spaceLower = spaceName.toLowerCase();
    const handleForPurchase = `${subspaceKey}@${spaceLower}`;
    const paymentMemo = `${subspaceKey}@${spaceName}:sptr`;

    try {
      const purchase = sptrQuote.pointerPurchase;
      const taprootAddress = sptrQuote.nextReceiveAddress;
      const totalPriceSats = sptrQuote.postTotalPriceSats;
      const amountBtc = totalPriceSats / 100_000_000;
      console.log(
        '[Subspace] Take on-chain payment (broadcast only):',
        JSON.stringify(
          {
            sptr_price_sats: sptrQuote.sptrPriceSats,
            post_total_price_sats: totalPriceSats,
            estimated_fee_sats: sptrQuote.estimatedFeeSats,
            approx_total_debit_sats: totalPriceSats + sptrQuote.estimatedFeeSats,
            taproot_address: taprootAddress,
            memo: paymentMemo,
            handle: handleForPurchase,
            purchase_id: purchaseIdFromRecord(purchase),
          },
          null,
          2
        )
      );

      const result = await WDKService.sendByNetworkWithMemo(
        NetworkType.SEGWIT,
        0,
        amountBtc,
        taprootAddress,
        AssetTicker.BTC,
        paymentMemo
      );
      console.log('[Subspace] Take on-chain send result:', result);
      const txid = transactionIdFromSendResult(result);
      if (txid) {
        const watch = await registerPointerPaymentWatchFromPostResponse(
          SPACES_API_BASE_URL,
          spaceLower,
          handleForPurchase,
          purchase,
          txid
        );
        if (!watch.ok) {
          if (watch.exhaustedRetries) {
            toast.error('Payment broadcast. Server could not register pointer watch.');
            Alert.alert(
              'Pointer payment watch failed',
              `Your transaction was broadcast (${txid.slice(0, 16)}…), but the Spaces server did not confirm watching it after ${SPACES_API_TRANSIENT_MAX_ATTEMPTS} attempts. Check your connection or try registering the transaction with the operator.`,
              [{ text: 'OK' }]
            );
          } else {
            toast.error(
              'Payment broadcast. Server rejected pointer watch (check handle / purchase state).'
            );
          }
        } else {
          toast.success('Payment broadcast');
          const jid = jobIdFromPurchaseRecord(purchase) ?? spaceData?.jobId;
          if (jid != null) {
            requestPurchaseStatusPoll({
              jobId: jid,
              spaceName: spaceLower,
              subspace: subspaceKey,
              unifiedStatusPurchaseType: 'pointer',
            });
          }
        }
      } else {
        console.warn(
          '[Subspace] Take on-chain: could not parse txid; skipping payment watch registration'
        );
        toast.success('Payment broadcast');
      }
      setShowTakeOnchainDialog(false);
    } catch (e) {
      console.error('[Subspace] Take on-chain send:', e);
      if (isInsufficientBalanceSendError(e)) {
        toast.error(
          'Not enough Bitcoin in this wallet for the payment plus network fee. Add funds and try again.'
        );
      } else {
        toast.error(e instanceof Error ? e.message : 'Payment failed');
      }
      setTakeOnchainStep('quote');
    }
  };

  const scriptPubkeyDisplay = spaceData?.scriptPubKeyHex?.trim() ?? '';
  const publicKeyDisplay =
    scriptPubkeyDisplay.length > 0
      ? (taprootXOnlyPubkeyHexFromScriptPubkeyHex(scriptPubkeyDisplay)?.toLowerCase() ?? '—')
      : '';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Header title={displayName} />

      <View style={styles.content}>
        {/* Status Display */}
        <View style={styles.topSection}>
          <View style={styles.subspaceNameContainer}>
            {chainResolutionLoading && !spaceData?.chainPresence ? (
              <View style={styles.statusRow}>
                <ActivityIndicator color={colors.primary} />
                <Text style={[styles.subspaceNameText, styles.statusLoadingText]}>
                  Status: Checking chain…
                </Text>
              </View>
            ) : (
              <Text style={styles.subspaceNameText}>Status: {getStatusText()}</Text>
            )}
          </View>

          {scriptPubkeyDisplay ? (
            <View style={styles.detailsCollapsible}>
              <TouchableOpacity
                style={styles.detailsCollapsibleHeader}
                onPress={() => setDetailsExpanded(!detailsExpanded)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ expanded: detailsExpanded }}
                accessibilityLabel="Details"
              >
                <View style={styles.detailsCollapsibleHeaderLeft}>
                  {detailsExpanded ? (
                    <ChevronDown size={20} color={colors.textSecondary} />
                  ) : (
                    <ChevronRight size={20} color={colors.textSecondary} />
                  )}
                  <Text style={styles.detailsCollapsibleHeaderText}>Details</Text>
                </View>
              </TouchableOpacity>
              {detailsExpanded ? (
                <View style={styles.cryptoSection}>
                  <Text style={styles.cryptoLabel}>Public Key</Text>
                  <View style={styles.cryptoValueBox}>
                    <Text style={styles.cryptoValueText} selectable>
                      {publicKeyDisplay}
                    </Text>
                  </View>
                  <Text style={styles.cryptoLabel}>Script Pubkey</Text>
                  <View style={styles.cryptoValueBox}>
                    <Text style={styles.cryptoValueText} selectable>
                      {scriptPubkeyDisplay.toLowerCase()}
                    </Text>
                  </View>
                  <View style={styles.cryptoTaprootLabelRow}>
                    <Text style={[styles.cryptoLabel, { marginBottom: 0 }]}>Taproot Address</Text>
                    {taprootDerivationPath ? (
                      <Text style={styles.cryptoDerivationPath} selectable>
                        {taprootDerivationPath}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.cryptoValueBox}>
                    {taprootAddressLoading ? (
                      <ActivityIndicator color={colors.text} style={styles.cryptoAddressSpinner} />
                    ) : (
                      <Text style={styles.cryptoValueText} selectable>
                        {taprootReceiveAddress ?? '—'}
                      </Text>
                    )}
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          {showTakeOnchainButton ? (
            <TouchableOpacity
              style={styles.takeOnchainButton}
              onPress={() => setShowTakeOnchainDialog(true)}
              activeOpacity={0.7}
              accessibilityLabel="Take subspace on-chain"
            >
              <Text style={styles.takeOnchainButtonText}>Take On-chain</Text>
            </TouchableOpacity>
          ) : null}

          {/* Hex Tool — only when listnums resolved to on-chain */}
          <TouchableOpacity
            style={[styles.hexToolButton, !isHexToolEnabled && styles.hexToolButtonDisabled]}
            onPress={() => {
              router.push({
                pathname: '/hex-tool',
                params: {
                  subspace: subspace,
                  spaceName: spaceName,
                  seedWireFromSubspace: '1',
                  ...(spaceData?.chainPresence != null
                    ? { chainPresence: spaceData.chainPresence }
                    : {}),
                  ...(spaceData?.listnumsLastDataHex
                    ? { listnumsLastDataHex: spaceData.listnumsLastDataHex }
                    : {}),
                  ...(spaceData?.newDataHex ? { newDataHex: spaceData.newDataHex } : {}),
                },
              });
            }}
            activeOpacity={0.7}
            disabled={!isHexToolEnabled}
            accessibilityState={{ disabled: !isHexToolEnabled }}
          >
            <Text style={styles.hexToolButtonText}>Hex Tool</Text>
          </TouchableOpacity>

          {hasPendingOnchainUpdate ? (
            <TouchableOpacity
              style={styles.updateOnchainButton}
              onPress={() => setShowUpdateOnchainModal(true)}
              activeOpacity={0.7}
              accessibilityLabel="Update on-chain data"
            >
              <Text style={styles.updateOnchainButtonText}>Update On-chain Data</Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            style={[
              styles.updateOnchainButton,
              receiveCertificateLoading ? styles.hexToolButtonDisabled : null,
            ]}
            onPress={handleReceiveCertificate}
            activeOpacity={0.7}
            disabled={receiveCertificateLoading}
            accessibilityLabel="Receive certificate"
            accessibilityState={{ disabled: receiveCertificateLoading }}
          >
            {receiveCertificateLoading ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={styles.updateOnchainButtonText}>
                {hasStoredCertificate ? 'Receive Latest Certificate' : 'Receive Certificate'}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.bottomSpacer} />

        {/* Delete Space Button */}
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={handleDeletePress}
          activeOpacity={0.7}
        >
          <Text style={styles.deleteButtonText}>Delete Space</Text>
        </TouchableOpacity>
      </View>

      {/* Delete Confirmation Dialog */}
      <Modal
        visible={showDeleteConfirmation}
        transparent={true}
        animationType="fade"
        onRequestClose={handleCancelDelete}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Confirm Delete</Text>
            <Text style={styles.deleteDialogText}>
              Are you sure, you want to delete {displayName}?
            </Text>
            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={handleCancelDelete}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalDeleteButton}
                onPress={handleConfirmDelete}
                activeOpacity={0.7}
              >
                <Text style={styles.modalDeleteButtonText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showTakeOnchainDialog}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (takeOnchainStep === 'loading' || takeOnchainStep === 'sending') return;
          setShowTakeOnchainDialog(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, styles.takeOnchainModalContent]}>
            <Text style={styles.modalTitle}>Take On-chain</Text>
            {takeOnchainStep === 'intro' || takeOnchainStep === 'loading' ? (
              <>
                <Text style={styles.takeOnchainDialogText}>
                  Taking {displayName} on-chain will disconnect your subname from the top-level name
                  operator. Future actions relating to {displayName} will be under your sovereign
                  control.
                </Text>
                <View style={styles.modalButtonRow}>
                  <TouchableOpacity
                    style={styles.modalCancelButton}
                    onPress={() => setShowTakeOnchainDialog(false)}
                    activeOpacity={0.7}
                    disabled={takeOnchainStep === 'loading'}
                  >
                    <Text style={styles.modalCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modalPurchaseButton,
                      takeOnchainStep === 'loading' && styles.modalPurchaseButtonDisabled,
                    ]}
                    onPress={handleTakeOnchainProceed}
                    activeOpacity={0.7}
                    disabled={takeOnchainStep === 'loading'}
                    accessibilityLabel="Proceed with take on-chain"
                  >
                    {takeOnchainStep === 'loading' ? (
                      <ActivityIndicator color={colors.black} />
                    ) : (
                      <Text style={styles.modalPurchaseButtonText}>Proceed</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : takeOnchainStep === 'quote' || takeOnchainStep === 'sending' ? (
              <>
                <ScrollView
                  style={styles.takeOnchainQuoteScroll}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {/* <Text style={styles.takeOnchainBreakdownLabel}>Spaces On-chain SPTR price</Text>
                  <Text style={styles.takeOnchainBreakdownValue}>
                    {sptrQuote ? `${sptrQuote.sptrPriceSats.toLocaleString()} sats` : '—'}
                  </Text> */}
                  <Text style={styles.takeOnchainBreakdownLabel}>
                    Payment to address (server total)
                  </Text>
                  <Text style={styles.takeOnchainBreakdownValue}>
                    {sptrQuote ? `${sptrQuote.postTotalPriceSats.toLocaleString()} sats` : '—'}
                  </Text>
                  <Text style={styles.takeOnchainBreakdownLabel}>Est. tx fee</Text>
                  <Text style={styles.takeOnchainBreakdownValue}>
                    {sptrQuote ? `${sptrQuote.estimatedFeeSats.toLocaleString()} sats` : '—'}
                  </Text>
                  <Text style={styles.takeOnchainBreakdownLabel}>
                    Approx. total debit (payment + tx fee)
                  </Text>
                  <Text style={styles.takeOnchainTotalValue}>
                    {sptrQuote ? `${sptrQuote.totalSats.toLocaleString()} sats` : '—'}
                  </Text>
                  <Text style={styles.takeOnchainHintFooter}>
                    Send the payment total to the address below.
                  </Text>
                  <Text style={styles.takeOnchainBreakdownLabel}>Pay to</Text>
                  <Text style={styles.takeOnchainAddress} selectable>
                    {sptrQuote?.nextReceiveAddress ?? ''}
                  </Text>
                </ScrollView>
                <View style={styles.modalButtonRow}>
                  <TouchableOpacity
                    style={styles.modalCancelButton}
                    onPress={() => setShowTakeOnchainDialog(false)}
                    activeOpacity={0.7}
                    disabled={takeOnchainStep === 'sending'}
                  >
                    <Text style={styles.modalCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modalPurchaseButton,
                      takeOnchainStep === 'sending' && styles.modalPurchaseButtonDisabled,
                    ]}
                    onPress={handleTakeOnchainPurchase}
                    activeOpacity={0.7}
                    disabled={takeOnchainStep === 'sending' || !sptrQuote}
                  >
                    {takeOnchainStep === 'sending' ? (
                      <ActivityIndicator color={colors.black} />
                    ) : (
                      <Text style={styles.modalPurchaseButtonText}>Purchase</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={showUpdateOnchainModal}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (updateOnchainStep === 'quoting' || updateOnchainStep === 'broadcasting') return;
          setShowUpdateOnchainModal(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Update On-chain Data</Text>
            {updateOnchainStep === 'intro' || updateOnchainStep === 'quoting' ? (
              <>
                <Text style={styles.updateOnchainHint}>
                  Build your wire payload in Hex Tool, then get a fee estimate before broadcasting.
                </Text>
                <Text style={styles.updateOnchainEstimateLabel}>Estimated transaction cost</Text>
                <Text style={styles.updateOnchainEstimateValue}>
                  {updateOnchainStep === 'quoting' ? '…' : 'Tap Purchase to calculate'}
                </Text>
                <View style={styles.modalButtonRow}>
                  <TouchableOpacity
                    style={styles.modalCancelButton}
                    onPress={() => setShowUpdateOnchainModal(false)}
                    activeOpacity={0.7}
                    disabled={updateOnchainStep === 'quoting'}
                  >
                    <Text style={styles.modalCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modalPurchaseButton,
                      updateOnchainStep === 'quoting' && styles.modalPurchaseButtonDisabled,
                    ]}
                    onPress={handleQuoteOnchainUpdate}
                    activeOpacity={0.7}
                    disabled={updateOnchainStep === 'quoting'}
                  >
                    {updateOnchainStep === 'quoting' ? (
                      <ActivityIndicator color={colors.black} />
                    ) : (
                      <Text style={styles.modalPurchaseButtonText}>Purchase</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.updateOnchainEstimateLabel}>Estimated network fee</Text>
                <Text style={styles.updateOnchainEstimateValue}>
                  {quotedFeeSats != null
                    ? `${quotedFeeSats.toLocaleString()} sats`
                    : 'Unknown (see Metro logs)'}
                </Text>
                {quotedUsdLabel ? (
                  <Text style={styles.updateOnchainUsdValue}>≈ {quotedUsdLabel}</Text>
                ) : (
                  <Text style={styles.updateOnchainHint}>
                    USD estimate unavailable until pricing loads.
                  </Text>
                )}
                <Text style={styles.updateOnchainHint}>
                  Network fee only; 1077 sats move in the transaction as designed by the protocol.
                </Text>
                <View style={styles.modalButtonRow}>
                  <TouchableOpacity
                    style={styles.modalCancelButton}
                    onPress={() => {
                      setUpdateOnchainStep('intro');
                      setQuotedFeeSats(null);
                      setQuotedUsdLabel(null);
                      setBroadcastParams(null);
                    }}
                    activeOpacity={0.7}
                    disabled={updateOnchainStep === 'broadcasting'}
                  >
                    <Text style={styles.modalCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modalPurchaseButton,
                      updateOnchainStep === 'broadcasting' && styles.modalPurchaseButtonDisabled,
                    ]}
                    onPress={handleConfirmOnchainBroadcast}
                    activeOpacity={0.7}
                    disabled={updateOnchainStep === 'broadcasting'}
                  >
                    {updateOnchainStep === 'broadcasting' ? (
                      <ActivityIndicator color={colors.black} />
                    ) : (
                      <Text style={styles.modalPurchaseButtonText}>Confirm Purchase</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  topSection: {
    gap: 12,
  },
  detailsCollapsible: {
    marginTop: 4,
  },
  detailsCollapsibleHeader: {
    paddingVertical: 8,
    marginBottom: 4,
  },
  detailsCollapsibleHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  detailsCollapsibleHeaderText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  cryptoSection: {
    gap: 6,
    marginTop: 4,
    marginBottom: 4,
  },
  cryptoLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 2,
  },
  cryptoTaprootLabelRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 2,
  },
  cryptoDerivationPath: {
    fontSize: 13,
    fontWeight: '400',
    color: colors.textSecondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  cryptoValueBox: {
    backgroundColor: colors.cardDark,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  cryptoValueText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  cryptoAddressSpinner: {
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  bottomSpacer: {
    flex: 1,
    minHeight: 16,
  },
  subspaceNameContainer: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subspaceNameText: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  statusLoadingText: {
    fontSize: 18,
  },
  takeOnchainButton: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  takeOnchainButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primary,
  },
  takeOnchainDialogText: {
    fontSize: 16,
    color: colors.text,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 22,
  },
  takeOnchainModalContent: {
    maxHeight: '88%',
  },
  takeOnchainQuoteScroll: {
    maxHeight: 280,
    marginBottom: 16,
  },
  takeOnchainBreakdownLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: 8,
    marginBottom: 4,
  },
  takeOnchainBreakdownValue: {
    fontSize: 16,
    color: colors.text,
    marginBottom: 4,
  },
  takeOnchainTotalValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
  },
  takeOnchainAddress: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  takeOnchainHintFooter: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
    marginBottom: 12,
  },
  hexToolButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  updateOnchainButton: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  updateOnchainButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primary,
  },
  hexToolButtonDisabled: {
    opacity: 0.45,
  },
  hexToolButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.black,
  },
  deleteButton: {
    backgroundColor: colors.error || '#ef4444',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 40,
  },
  deleteButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white || '#ffffff',
  },
  errorText: {
    fontSize: 16,
    color: colors.text,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
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
  deleteDialogText: {
    fontSize: 16,
    color: colors.text,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 22,
  },
  updateOnchainEstimateLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 6,
    textAlign: 'center',
  },
  updateOnchainEstimateValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  updateOnchainUsdValue: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  updateOnchainHint: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 20,
  },
  modalButtonRow: {
    flexDirection: 'row',
    gap: 12,
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
  modalPurchaseButton: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPurchaseButtonDisabled: {
    opacity: 0.7,
  },
  modalPurchaseButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.black,
  },
});
