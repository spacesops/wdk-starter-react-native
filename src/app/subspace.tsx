import Header from '@/components/header';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { AssetTicker, NetworkType, WDKService } from '@tetherto/wdk-react-native-provider';
import { FiatCurrency, pricingService } from '@/services/pricing-service';
import {
  buildSpacesScanDerivationPaths,
  fullPathToWalletRelativePath,
  getBitcoinTaprootPathPrefix,
} from '@/utils/spaces-scan-paths';
import { WDKSpaces, type UpdateOnchainHexParams } from '@/utils/wdk-spaces';

const SPACES_API_BASE_URL = process.env.EXPO_PUBLIC_SPACES_API_BASE_URL || 'http://192.168.1.111:7264';

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
  status?:
    | 'purchasing'
    | 'purchased'
    | 'pending'
    | 'processing'
    | 'confirmed'
    | 'expired'
    | 'cancelled'
    | string;
  jobId?: number;
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
  estimatedFeeSats: number;
  totalSats: number;
  nextReceiveAddress: string;
};

function parseNumSats(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Parse GET /api/tenants/:space_name/sptr-price JSON (field names may vary). */
function parseSptrPriceResponse(body: unknown): SptrPriceQuote {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const price = parseNumSats(
    o.sptr_price_sats ?? o.sptr_price ?? o.price_sats ?? o.sptrPriceSats ?? o.sptr_price_sat
  );
  const fee = parseNumSats(
    o.estimated_fee_sats ?? o.estimated_fee ?? o.estimatedFeeSats ?? o.network_fee_sats ?? 0
  );
  const addrRaw =
    typeof o.next_receive_address === 'string'
      ? o.next_receive_address
      : typeof o.nextReceiveAddress === 'string'
        ? o.nextReceiveAddress
        : '';
  const nextReceiveAddress = addrRaw.trim();
  if (!Number.isFinite(price) || price < 0) {
    throw new Error('Invalid or missing sptr price (satoshis) in sptr-price response');
  }
  if (!Number.isFinite(fee) || fee < 0) {
    throw new Error('Invalid estimated_fee_sats in sptr-price response');
  }
  if (!nextReceiveAddress) {
    throw new Error('Missing next_receive_address in sptr-price response');
  }
  const estimatedFeeSats = Math.max(0, fee);
  const totalSats = price + estimatedFeeSats;
  return {
    sptrPriceSats: price,
    estimatedFeeSats,
    totalSats,
    nextReceiveAddress,
  };
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
async function resolveTaprootForScriptPubKey(
  scriptPubKeyHex: string
): Promise<{ address: string; priorAccountRelativePath: string } | null> {
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
  return {
    address: entries[idx].address!,
    priorAccountRelativePath: rels[idx],
  };
}

export default function SubspaceScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const { subspace, spaceName, scriptPubKeyHex: scriptPubKeyHexParam } = useLocalSearchParams<{
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

  const takeOnchainDialogVisibleRef = useRef(false);
  useEffect(() => {
    takeOnchainDialogVisibleRef.current = showTakeOnchainDialog;
  }, [showTakeOnchainDialog]);

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
              status: space.status,
              jobId: space.jobId,
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
                    scriptPubKeyHex: space.scriptPubKeyHex ?? prev.scriptPubKeyHex ?? scriptPubKeyHexParam,
                    chainPresence: space.chainPresence ?? prev.chainPresence,
                    listnumsLastDataHex: space.listnumsLastDataHex ?? prev.listnumsLastDataHex,
                    priorTxid: space.priorTxid ?? prev.priorTxid,
                    newDataHex: space.newDataHex ?? prev.newDataHex,
                    status: space.status ?? prev.status,
                    jobId: space.jobId ?? prev.jobId,
                  }
                : {
                    subspace: space.subspace,
                    spaceName: space.spaceName,
                    status: space.status,
                    jobId: space.jobId,
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
    if (row.chainPresence) return false;
    if (row.status === 'discovered') return true;
    if (!row.status) return true;
    return !KNOWN_PURCHASE_STATUSES.has(row.status);
  };

  async function resolveScriptPubKeyForListnums(row: MySpaceRow): Promise<string | null> {
    const fromParamOrStore = scriptPubKeyHexParam || row.scriptPubKeyHex;
    if (fromParamOrStore) return fromParamOrStore;

    const fullPaths = buildSpacesScanDerivationPaths();
    if (fullPaths.length !== 1) {
      console.warn(
        '[Subspace] listnums-by-spk needs scriptPubKeyHex or a single scan path (EXPO_PUBLIC_SPACES_ACCOUNT_GAP=1)'
      );
      return null;
    }
    const { bip, coinType } = getBitcoinTaprootPathPrefix();
    const rel = fullPathToWalletRelativePath(fullPaths[0], bip, coinType);
    if (rel == null) return null;
    try {
      const { addressesJson } = await WDKSpaces.deriveTaprootAddressesFromPaths([rel]);
      const entries = JSON.parse(addressesJson) as { scriptPubKeyHex?: string }[];
      const hex = entries[0]?.scriptPubKeyHex;
      return typeof hex === 'string' && hex.length > 0 ? hex : null;
    } catch (e) {
      console.error('[Subspace] deriveTaprootAddressesFromPaths failed:', e);
      return null;
    }
  }

  useEffect(() => {
    if (!subspace || !spaceName || !spaceData) return;
    if (!shouldRunListnumsResolution(spaceData)) return;

    let cancelled = false;
    (async () => {
      setChainResolutionLoading(true);
      try {
        const spk = await resolveScriptPubKeyForListnums(spaceData);
        if (cancelled || !spk) {
          if (!spk) {
            toast.error('Missing script pubkey for chain check — run Find Spaces or set gap to 1');
          }
          return;
        }
        const { nums } = await fetchListnumsBySpk(spk);
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

  const handleDeletePress = () => {
    setShowDeleteConfirmation(true);
  };

  const handleCancelDelete = () => {
    setShowDeleteConfirmation(false);
  };

  const handleConfirmDelete = async () => {
    if (!spaceData) return;

    const { subspace: spaceSubspace, spaceName: spaceSpaceName, jobId } = spaceData;

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
        console.log('[Subspace] Removed space from AsyncStorage:', spaceSubspace, '@', spaceSpaceName);
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

  // Get formatted status (chain presence from listnums takes precedence over purchase status)
  const getStatusText = (): string => {
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
    Boolean(spaceData) &&
    !chainResolutionLoading &&
    spaceData?.chainPresence !== 'off-chain';

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
    const url = `${SPACES_API_BASE_URL}/api/tenants/${encodeURIComponent(spaceName)}/sptr-price`;
    console.log('[Subspace] sptr-price — GET', url);
    try {
      const res = await fetch(url);
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!res.ok) {
        throw new Error(`sptr-price failed (${res.status})`);
      }
      const quote = parseSptrPriceResponse(body);
      if (!takeOnchainDialogVisibleRef.current) return;
      setSptrQuote(quote);
      setTakeOnchainStep('quote');
      console.log('[Subspace] sptr-price — parsed', quote);
    } catch (e) {
      console.error('[Subspace] sptr-price:', e);
      toast.error(e instanceof Error ? e.message : 'Could not load price');
      if (takeOnchainDialogVisibleRef.current) {
        setTakeOnchainStep('intro');
      }
    }
  };

  const handleTakeOnchainPurchase = async () => {
    if (!sptrQuote) return;
    setTakeOnchainStep('sending');
    /** Payment to `next_receive_address` is SPTR price; wallet pays network fee in addition. */
    const amountBtc = sptrQuote.sptrPriceSats / 100_000_000;
    const paymentLog = {
      sptr_price_sats: sptrQuote.sptrPriceSats,
      estimated_fee_sats: sptrQuote.estimatedFeeSats,
      approx_total_debit_sats: sptrQuote.totalSats,
      next_receive_address: sptrQuote.nextReceiveAddress,
      amount_sent_to_recipient_sats: sptrQuote.sptrPriceSats,
      memo: spaceName,
      space_name: spaceName,
      subspace,
      displayName,
    };
    console.log('[Subspace] Take on-chain payment quote (before send):', JSON.stringify(paymentLog, null, 2));
    try {
      const result = await WDKService.sendByNetworkWithMemo(
        NetworkType.SEGWIT,
        0,
        amountBtc,
        sptrQuote.nextReceiveAddress,
        AssetTicker.BTC,
        spaceName
      );
      console.log('[Subspace] Take on-chain send result:', result);
      toast.success('Payment broadcast');
      setShowTakeOnchainDialog(false);
    } catch (e) {
      console.error('[Subspace] Take on-chain send:', e);
      toast.error(e instanceof Error ? e.message : 'Payment failed');
      setTakeOnchainStep('quote');
    }
  };

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
                  Taking {displayName} on-chain will disconnect your subname from the top-level name operator. Future
                  actions relating to {subspace} will be under your sovereign control.
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
                  showsVerticalScrollIndicator={false}>
                  <Text style={styles.takeOnchainBreakdownLabel}>SPTR price</Text>
                  <Text style={styles.takeOnchainBreakdownValue}>
                    {sptrQuote ? `${sptrQuote.sptrPriceSats.toLocaleString()} sats` : '—'}
                  </Text>
                  <Text style={styles.takeOnchainBreakdownLabel}>Estimated fee</Text>
                  <Text style={styles.takeOnchainBreakdownValue}>
                    {sptrQuote ? `${sptrQuote.estimatedFeeSats.toLocaleString()} sats` : '—'}
                  </Text>
                  <Text style={styles.takeOnchainBreakdownLabel}>Approx. total (price + est. fee)</Text>
                  <Text style={styles.takeOnchainTotalValue}>
                    {sptrQuote ? `${sptrQuote.totalSats.toLocaleString()} sats` : '—'}
                  </Text>
                  <Text style={styles.takeOnchainHintFooter}>
                    You send the SPTR price to the address below; the network fee is paid from your balance on top of
                    that (exact fee may differ).
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
                  <Text style={styles.updateOnchainHint}>USD estimate unavailable until pricing loads.</Text>
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
