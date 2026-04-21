import Header from '@/components/header';
import { useDebouncedNavigation } from '@/hooks/use-debounced-navigation';
import { AtSign, Check, ChevronDown, ChevronRight, ChevronUp, Circle, Copy, Info } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/colors';
import { pricingService, FiatCurrency } from '@/services/pricing-service';
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
import { WDKSpaces } from '@/utils/wdk-spaces';
import * as Clipboard from 'expo-clipboard';
import { toast } from 'sonner-native';

const SPACE_NAME_OPTIONS = ['spacesops_services', 'are_currently_unavailable', 'try_again_later'];
const DURATION_OPTIONS = ['~10 mins', '~1 hour', '~8 hours'];
const SPACES_API_BASE_URL = process.env.EXPO_PUBLIC_SPACES_API_BASE_URL || 'http://192.168.1.111:7264';
const SPACES_APP_NAME = 'spaces-wallet';

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
  state: 'available' | 'taken';
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

export default function SpacesScreen() {
  const insets = useSafeAreaInsets();
  const router = useDebouncedNavigation();
  const { wallet, addresses, balances } = useWallet();
  const [subspace, setSubspace] = useState('');
  const [spaceName, setSpaceName] = useState<string>('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [buttonState, setButtonState] = useState<'available' | 'taken' | 'loading' | null>(null);
  const [isButtonEnabled, setIsButtonEnabled] = useState(false);
  const [buttonLabel, setButtonLabel] = useState('Purchase');
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
      /** Set on space details when purchase status was unknown; from GET /api/listnums-by-spk. */
      chainPresence?: 'on-chain' | 'off-chain';
      /** Last `nums` entry `data` when chainPresence is on-chain. */
      listnumsLastDataHex?: string;
      /** User-saved wire hex from Hex Tool (Save Hex String). */
      newDataHex?: string;
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
  const [isAboutSpacesExpanded, setIsAboutSpacesExpanded] = useState(false);

  const handleSubspaceSelect = (space: {
    subspace: string;
    spaceName: string;
    scriptPubKeyHex?: string;
  }) => {
    router.push({
      pathname: '/subspace',
      params: {
        subspace: space.subspace,
        spaceName: space.spaceName,
        ...(space.scriptPubKeyHex ? { scriptPubKeyHex: space.scriptPubKeyHex } : {}),
      },
    });
  };


  const getSpaceStatus = (subspace: string, spaceName: string): string => {
    const space = mySpaces.find((s) => s.subspace === subspace && s.spaceName === spaceName);
    if (!space) return 'Unknown';

    if (space.chainPresence === 'on-chain') return 'On-chain';
    if (space.chainPresence === 'off-chain') return 'Off-chain';

    const statusMap: Record<UnifiedStatus, string> = {
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
      purchasing: 'Purchasing', // Legacy status
      requesting: 'Requesting',
      discovered: 'Discovered',
    };

    return statusMap[space.status] || 'Unknown';
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

  const handleCopyTxHex = async () => {
    try {
      await Clipboard.setStringAsync(txHex);
      toast.success('Transaction hex copied to clipboard');
    } catch (error) {
      console.error('[Spaces] Failed to copy transaction hex:', error);
      Alert.alert('Error', 'Failed to copy transaction hex to clipboard');
    }
  };

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
          const findHandlesUrl = `${SPACES_API_BASE_URL}/api/subsd/find-handles`;
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
    } = {}
  ) => {
    const {
      initialDelay = 2000, // Start with 2 seconds
      maxDelay = 300000, // Max 5 minutes
      maxAttempts = 100,
    } = options;

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

    const updateSpaceStatus = (status: UnifiedStatus) => {
      setMySpaces((prev) =>
        prev.map((space) =>
          space.subspace === subspace && space.spaceName === spaceName.toLowerCase()
            ? { ...space, status: status, jobId }
            : space
        )
      );
    };

    // Try to use unified status endpoint if we have spaceName and subspace
    const unifiedStatusUrl = `${SPACES_API_BASE_URL}/api/purchases/${spaceName}/${subspace}/status`;

    while (attempt < maxAttempts) {
      try {
        // Set next check time (for first attempt, this is immediate, then uses delay)
        const nextCheckTime = attempt === 0 ? Date.now() : Date.now() + delay;
        updatePollingState(nextCheckTime, true);
        console.log(
          `[Spaces] Polling job ${jobId} - attempt ${attempt + 1}${attempt > 0 ? `, next check in ${delay}ms` : ' (immediate)'}`
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
            console.log(`[Spaces] Got unified status: ${unifiedStatus} for ${subspace}@${spaceName}`);
          }
        } catch (unifiedError) {
          console.warn(`[Spaces] Unified status endpoint failed, falling back to job status:`, unifiedError);
          // Fallback to job status endpoint
          response = await fetch(url);
          data = await response.json();
        }

        if (!data.success) {
          throw new Error(data.message || 'Failed to fetch job status');
        }

        // Use unified status if available, otherwise map from job status
        if (unifiedStatus) {
          updateSpaceStatus(unifiedStatus);
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
          const mappedStatus = statusMap[job.status] || 'pending_payment';
          updateSpaceStatus(mappedStatus);
        }

        // Check for terminal states
        const terminalStates: UnifiedStatus[] = ['certificate_delivered', 'sptr_delivered', 'expired', 'cancelled'];
        const currentStatus = unifiedStatus || (data.purchase?.unified_status as UnifiedStatus) || 'pending_payment';
        
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
  };

  const handleSimulate = async () => {
    console.log('[Spaces] Simulate transaction:', txHex);
    console.log('[Spaces] Current jobId:', currentJobId);
    console.log('[Spaces] Current jobData:', currentJobData);

    // Close the modal first
    setShowTxHexModal(false);

    if (!currentJobId || !currentJobData) {
      console.warn('[Spaces] Cannot simulate: missing jobId or jobData', {
        currentJobId,
        currentJobData,
      });
      toast.info('Simulation will be implemented soon');
      return;
    }

    const { handle, subspace: currentSubspace, spaceName: currentSpaceName } = currentJobData;

    // Add subspace to My Spaces and start polling
    const newSpace = {
      subspace: currentSubspace,
      spaceName: currentSpaceName,
      handle,
      status: 'pending' as const,
      jobId: currentJobId,
    };

    console.log('[Spaces] Adding space to My Spaces:', newSpace);

    setMySpaces((prev) => {
      const existingIndex = prev.findIndex(
        (s) => s.subspace === newSpace.subspace && s.spaceName === newSpace.spaceName
      );
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = { ...updated[existingIndex], jobId: currentJobId };
        return updated;
      }
      return [...prev, newSpace];
    });

    console.log('[Spaces] Starting polling for job:', currentJobId);

    // Start polling
    pollJobStatus(currentJobId, currentSpaceName, currentSubspace).catch((error) => {
      console.error('[Spaces] Polling failed:', error);
    });

    toast.info('Simulation started - monitoring job status');
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

      // Add subspace to My Spaces and start polling if we have jobId
      if (currentJobId && purchaseData) {
        const currentSpaceName = spaceName.toLowerCase();
        const currentSubspace = subspace.trim();
        const newSpace = {
          subspace: currentSubspace,
          spaceName: currentSpaceName,
          handle: purchaseData.handle,
          status: 'processing' as const,
          jobId: currentJobId,
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
            };
            return updated;
          }
          return [...prev, newSpace];
        });

        // Start polling
        pollJobStatus(currentJobId, currentSpaceName, currentSubspace).catch((error) => {
          console.error('[Spaces] Polling failed:', error);
        });
      }

      // Close the modal
      setShowTxHexModal(false);

      // Perform simulation after broadcasting (this will also start polling)
      await handleSimulate();
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
            body: JSON.stringify({ quote_id: quoteId }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Spaces API] PUT ${url} - HTTP error! status: ${response.status}`, errorText);
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const data = await response.json();
          console.log(`[Spaces API] PUT ${url} - Success (free coupon)`, data);

          if (data.job_id) {
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
                      purchaseId: data.purchase_id,
                      sptrJobId: data.sptr_job_id || undefined,
                      sptrPurchaseId: data.sptr_purchase_id || undefined,
                      hasSptr: !!data.sptr_job_id,
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
                purchase_id: data.purchase_id,
                sptr_job_id: data.sptr_job_id,
                sptr_purchase_id: data.sptr_purchase_id,
                has_sptr: !!data.sptr_job_id,
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
            if (blockFee !== null && btcPriceUSD !== null) {
              setButtonLabel(calculateTotalPrice(priceSats, blockFee1, blockFee6, blockFee48, selectedDuration, btcPriceUSD, takeOnchain, sptrPrice, sptrFee1, sptrFee6, sptrFee48));
            }
          }

          toast.success(`Requested ${purchaseData.handle} for free!`);
        } catch (error) {
          console.error('[Spaces] Free coupon request failed:', error);
          Alert.alert('Error', error instanceof Error ? error.message : 'Failed to process request');
          setButtonState('available');
          setIsButtonEnabled(true);
        }
        return;
      }

      setButtonState('loading');
      setIsButtonEnabled(false);
      setButtonLabel('Composing Transaction...');

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
          value: purchaseData.total_price,
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
            amount: purchaseData.total_price / 100000000,
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
          const requestedSats = purchaseData.total_price;
          let estimatedFeeSats = 0;
          let totalRequiredSats = requestedSats;
          try {
            const feeQuote = await WDKService.quoteSendByNetworkWithMemo(
              quoteOptions.network,
              quoteOptions.accountIndex,
              quoteOptions.amount,
              quoteOptions.recipientAddress,
              quoteOptions.asset,
              quoteOptions.memo
            );
            estimatedFeeSats = Math.round(feeQuote * 100000000);
            totalRequiredSats = requestedSats + estimatedFeeSats;
          } catch (feeError) {
            console.warn('[Spaces] Could not estimate fee, using amount only:', feeError);
          }

          console.log('[Spaces] Balance check (P2TR):', {
            balanceBTC: balanceBTC.toFixed(8),
            balanceSats: Math.round(balanceSats),
            requestedAmountSats: requestedSats,
            requestedAmountBTC: quoteOptions.amount.toFixed(8),
            estimatedFeeSats,
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
            amount: purchaseData.total_price / 100000000,
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
          let estimatedFee = 0;
          let totalRequired = quoteOptions.amount;
          try {
            const feeQuote = await WDKService.quoteSendByNetwork(
              quoteOptions.network,
              quoteOptions.accountIndex,
              quoteOptions.amount / 100000000, // Convert to BTC for quote
              quoteOptions.recipientAddress,
              quoteOptions.asset
            );
            // Fee is returned in base units (BTC), convert to satoshis
            estimatedFee = feeQuote * 100000000;
            totalRequired = quoteOptions.amount + estimatedFee;
          } catch (feeError) {
            console.warn('[Spaces] Could not estimate fee, using amount only:', feeError);
            // If fee estimation fails, we'll let the transaction attempt proceed
            // and it will fail with a more specific error
          }

          console.log('[Spaces] Balance check:', {
            balanceBTC: balanceBTC.toFixed(8),
            balanceSats: Math.round(balanceSats),
            requestedAmount: quoteOptions.amount,
            requestedAmountBTC: (quoteOptions.amount / 100000000).toFixed(8),
            estimatedFee: Math.round(estimatedFee),
            estimatedFeeBTC: (estimatedFee / 100000000).toFixed(8),
            totalRequired: Math.round(totalRequired),
            totalRequiredBTC: (totalRequired / 100000000).toFixed(8),
            sufficient: balanceSats >= totalRequired,
          });

          if (balanceSats < totalRequired) {
            const shortfall = totalRequired - balanceSats;
            console.error('[Spaces] Insufficient balance (including fees):', {
              balanceBTC: balanceBTC.toFixed(8),
              balanceSats: Math.round(balanceSats),
              requestedAmount: quoteOptions.amount,
              estimatedFee: Math.round(estimatedFee),
              totalRequired: Math.round(totalRequired),
              shortfall: Math.round(shortfall),
              shortfallBTC: (shortfall / 100000000).toFixed(8),
            });
            throw new Error(
              `Insufficient balance. Have ${Math.round(balanceSats)} sats, need ${Math.round(totalRequired)} sats (${quoteOptions.amount} amount + ${Math.round(estimatedFee)} fee, shortfall: ${Math.round(shortfall)} sats)`
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
            amount: purchaseData.total_price,
            recipientAddress: purchaseData.taproot_address,
            asset: AssetTicker.BTC,
            memo: purchaseData.handle,
          });
        } else {
          setTxHexData({
            scriptType: 'P2WPKH',
            network: NetworkType.SEGWIT,
            accountIndex: 0,
            amount: purchaseData.total_price,
            recipientAddress: purchaseData.taproot_address,
            asset: AssetTicker.BTC,
          });
        }

        // Add subspace to My Spaces list with "purchasing" status
        const newSpace = {
          subspace: subspace.trim(),
          spaceName: spaceName.toLowerCase(),
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

        // Display transaction hex in modal
        setTxHex(transactionHex);
        setShowTxHexModal(true);

        // Reset button state while showing modal
        setButtonState('available');
        setIsButtonEnabled(true);

        // Send PUT request to confirm purchase
        const spaceNameLower = spaceName.toLowerCase();
        const url = `${SPACES_API_BASE_URL}/spaces/${spaceNameLower}/${subspace.trim()}?app=${SPACES_APP_NAME}&format=json`;
        const startTime = Date.now();
        console.log(`[Spaces API] PUT ${url}`);

        const requestBody = {
          quote_id: quoteId,
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
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log(`[Spaces API] PUT ${url} - Success (${duration}ms)`, data);

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

        // Update space entry with job IDs and purchase IDs
        setMySpaces((prev) =>
          prev.map((space) =>
            space.subspace === subspace.trim() && space.spaceName === spaceNameLower
              ? {
                  ...space,
                  jobId: data.job_id,
                  purchaseId: data.purchase_id,
                  sptrJobId: data.sptr_job_id || undefined,
                  sptrPurchaseId: data.sptr_purchase_id || undefined,
                  hasSptr: !!data.sptr_job_id,
                  status: 'pending_payment' as UnifiedStatus,
                }
              : space
          )
        );

        // Store job_id and handle in local storage
        if (data.job_id && data.handle) {
          const storageKey = `spaces_purchase_${data.job_id}`;
          const storageData = {
            job_id: data.job_id,
            handle: data.handle,
            quote_id: data.quote_id,
            purchase_id: data.purchase_id,
            sptr_job_id: data.sptr_job_id,
            sptr_purchase_id: data.sptr_purchase_id,
            has_sptr: !!data.sptr_job_id,
            timestamp: Date.now(),
          };
          await AsyncStorage.setItem(storageKey, JSON.stringify(storageData));
          console.log('[Spaces] Stored purchase data in AsyncStorage:', storageKey, storageData);
        }

        // Reset confirmation mode
        setIsConfirmationMode(false);
        setPurchaseData(null);
        setButtonState('available');
        setIsButtonEnabled(true);

        // Recalculate button label
        if (priceSats !== null) {
          const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48);
          if (blockFee !== null && btcPriceUSD !== null) {
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
        console.error('[Spaces] Error in confirmation flow:', error);

        // Enhanced error logging for insufficient balance
        if (error instanceof Error && error.message.includes('Insufficient balance')) {
          const btcBalance = balances?.list?.find(
            (b) => b.networkType === NetworkType.SEGWIT && b.denomination === AssetTicker.BTC
          );
          // Convert balance from BTC to satoshis (balance.value is in BTC, multiply by 100M)
          const balanceBTC = btcBalance ? parseFloat(btcBalance.value) : 0;
          const balanceSats = balanceBTC * 100000000;
          const requestedAmount = purchaseData?.total_price || 0;

          console.error('[Spaces] Insufficient balance details:', {
            errorMessage: error.message,
            balanceBTC: balanceBTC.toFixed(8),
            balanceSats: Math.round(balanceSats),
            requestedAmount,
            requestedAmountBTC: (requestedAmount / 100000000).toFixed(8),
            shortfall: Math.round(requestedAmount - balanceSats),
            shortfallBTC: ((requestedAmount - balanceSats) / 100000000).toFixed(8),
            fromAddress: addresses?.[NetworkType.SEGWIT],
            recipientAddress: purchaseData?.taproot_address,
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
          error instanceof Error ? error.message : 'Failed to process transaction'
        );
        setButtonState('available');
        setIsButtonEnabled(true);
        // Restore button label
        if (purchaseData && btcPriceUSD !== null) {
          const formattedSats = purchaseData.total_price.toLocaleString();
          const satsPerBitcoin = 100000000;
          const usdAmount = (purchaseData.total_price / satsPerBitcoin) * btcPriceUSD;
          const formattedUSD = usdAmount.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          setButtonLabel(
            `Send ${formattedSats} sats = $${formattedUSD} for ${purchaseData.handle}`
          );
        } else if (purchaseData) {
          const formattedSats = purchaseData.total_price.toLocaleString();
          setButtonLabel(`Send ${formattedSats} sats for ${purchaseData.handle}`);
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
        block_fee: blockFee,
        handle: handle,
        price: priceSats,
        quote_id: quoteId,
        conf_target: confTarget,
        sptr: takeOnchain ? 'true' : 'false',
        sptr_price: sptrPrice,
        block_sptr_fee: sptrBlockFee,
      };
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
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log(`[Spaces API] POST ${url} - Success (${duration}ms)`, data);

      // Store purchase data and enter confirmation mode
      setPurchaseData({
        taproot_address: data.taproot_address,
        handle: data.handle,
        total_price: data.total_price,
        expiring_blockheight: data.expiring_blockheight,
      });
      setIsConfirmationMode(true);

      // Calculate USD equivalent for button label
      const totalPrice = data.total_price;
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

      console.error(`[Spaces API] POST ${url} - Failed (${duration}ms):`, error);

      setButtonState(null);
      setIsButtonEnabled(false);
      setButtonLabel('Purchase');
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to process purchase');
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

      // Reset button state to initial
      setButtonState('available');
      setIsButtonEnabled(true);

      // Recalculate button label based on current price and duration
      if (priceSats !== null) {
        const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48);
        if (blockFee !== null && btcPriceUSD !== null) {
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
    if (completelyFree) return 0;
    if (discountPercent === null) return purchaseData.total_price;

    const blockFee = getBlockFee(selectedDuration, blockFee1, blockFee6, blockFee48) ?? 0;
    const discountedPrice = Math.floor(priceSats * (100 - discountPercent) / 100);
    let total = blockFee + discountedPrice;
    if (takeOnchain && sptrPrice !== null) {
      const sptrFee = getSptrFee(selectedDuration, sptrFee1, sptrFee6, sptrFee48);
      if (sptrFee !== null) total += sptrPrice + sptrFee;
    }
    return total;
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
    getBlockFee,
    getSptrFee,
  ]);

  // Initialize pricing service and fetch BTC price
  useEffect(() => {
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
          if (refreshedPrice) {
            setBtcPriceUSD(refreshedPrice);
          }
        }
      } catch (error) {
        console.error('[Spaces] Failed to load BTC price:', error);
        // Fallback to a default price if fetch fails
        setBtcPriceUSD(89018);
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
      } catch (error) {
        console.error('[Spaces] Failed to refresh BTC price:', error);
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

  // Check space availability when subspace or spaceName changes
  useEffect(() => {
    const checkAvailability = async () => {
      // Only make request if both fields have values
      if (!subspace.trim() || !spaceName) {
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
          console.error(
            `[Spaces API] GET ${url} - HTTP error! status: ${response.status} (${duration}ms)`
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
    };

    // Debounce the API call
    const timeoutId = setTimeout(() => {
      checkAvailability();
    }, 500); // Wait 500ms after user stops typing

    return () => clearTimeout(timeoutId);
  }, [subspace, spaceName]);

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
          (space: { jobId?: number; status: UnifiedStatus }) =>
            space.jobId && !terminalStates.includes(space.status)
        );

        if (activeSpaces.length > 0) {
          console.log('[Spaces] Resuming polling for', activeSpaces.length, 'active jobs');
          activeSpaces.forEach(
            (space: { jobId: number; subspace: string; spaceName: string }) => {
              pollJobStatus(space.jobId, space.spaceName, space.subspace).catch((error) => {
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

    const displayTotal =
      discountPercent !== null && priceSats !== null
        ? (getDiscountedTotal() ?? purchaseData.total_price)
        : purchaseData.total_price;

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
  }, [completelyFree, discountPercent, couponStatus, isConfirmationMode, purchaseData, btcPriceUSD, priceSats, getDiscountedTotal]);

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

            {/* Take Onchain Checkbox */}
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
          onRequestClose={() => setShowTxHexModal(false)}
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
                <TouchableOpacity
                  style={styles.modalDismissButton}
                  onPress={() => setShowTxHexModal(false)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalDismissButtonText}>Dismiss</Text>
                </TouchableOpacity>
              </View>
              <View style={[styles.modalButtonRow, styles.modalButtonRowSpacing]}>
                <TouchableOpacity
                  style={styles.modalSimulateButton}
                  onPress={handleSimulate}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalSimulateButtonText}>Simulate</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalBroadcastButton}
                  onPress={handleBroadcast}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalBroadcastButtonText}>Broadcast</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Spaces List Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <AtSign size={20} color={colors.primary} />
            <Text style={styles.sectionTitle}>My Spaces</Text>
          </View>

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
                <Text style={styles.tableHeaderText}>Space</Text>
                <Text style={styles.tableHeaderText}>Status</Text>
                <Text style={styles.tableHeaderText}>Next Check</Text>
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
                      style={styles.tableCellSpace}
                      onPress={() => handleSubspaceSelect(space)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.tableCellSpaceText}>
                        {space.subspace}@{space.spaceName}
                      </Text>
                    </TouchableOpacity>
                    <View style={styles.tableCellStatus}>
                      <Text style={styles.tableCellStatusText}>{statusText}</Text>
                    </View>
                    <View style={styles.tableCellNextCheck}>
                      <Text style={styles.tableCellNextCheckText}>
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
    paddingVertical: 12,
    marginBottom: 12,
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
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    textTransform: 'uppercase',
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
  tableCellSpace: {
    flex: 1,
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
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  tableCellStatusText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  tableCellNextCheck: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
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
