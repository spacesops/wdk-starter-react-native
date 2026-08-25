import AsyncStorage from '@react-native-async-storage/async-storage';
import { AssetTicker } from '@/config/assets';

const STORAGE_KEY_EARLIEST_DATES = 'wdk_earliest_token_dates';
const STORAGE_KEY_HISTORICAL_PRICES = 'wdk_historical_prices';
const MAX_POINTS_PER_TOKEN = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Price history window: 100 days from today at midnight. */
const CHART_DAYS_MS = 100 * DAY_MS;

/** Midnight UTC (ms) for the day containing tsMs. */
function dayMidnightMs(tsMs: number): number {
  return Math.floor(tsMs / DAY_MS) * DAY_MS;
}

/**
 * Contiguous day ranges missing from existing data between startMs and today at midnight.
 * Returns [{ startMs, endMs }, ...] where each range is midnight-to-midnight (endMs is exclusive for the last day).
 */
function missingDayRanges(
  existing: HistoricalPricePoint[],
  startMs: number,
  todayMidnightMs: number
): Array<{ startMs: number; endMs: number }> {
  const haveDays = new Set<number>();
  for (const p of existing) {
    haveDays.add(dayMidnightMs(p.ts));
  }
  const rangeStartDay = dayMidnightMs(startMs);
  const rangeEndDay = todayMidnightMs;
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  let gapStart: number | null = null;
  for (let dayMs = rangeStartDay; dayMs <= rangeEndDay; dayMs += DAY_MS) {
    const hasDay = haveDays.has(dayMs);
    if (!hasDay) {
      if (gapStart === null) gapStart = dayMs;
    } else {
      if (gapStart !== null) {
        const lastMissingDayMs = dayMs - DAY_MS;
        ranges.push({ startMs: gapStart, endMs: lastMissingDayMs + DAY_MS });
        gapStart = null;
      }
    }
  }
  if (gapStart !== null) {
    ranges.push({ startMs: gapStart, endMs: rangeEndDay + DAY_MS - 1 });
  }
  return ranges;
}

/** Listeners notified when historical prices are saved (e.g. after sync). */
const historicalPricesUpdatedListeners = new Set<() => void>();

/**
 * Subscribe to historical price updates (e.g. after sync completes).
 * Returns an unsubscribe function.
 */
export function onHistoricalPricesUpdated(callback: () => void): () => void {
  historicalPricesUpdatedListeners.add(callback);
  return () => historicalPricesUpdatedListeners.delete(callback);
}

function notifyHistoricalPricesUpdated(): void {
  historicalPricesUpdatedListeners.forEach((cb) => cb());
}

export interface HistoricalPricePoint {
  price: number;
  ts: number;
}

export interface TokenHistoricalPrices {
  lastUpdated: number;
  data: HistoricalPricePoint[];
}

export type EarliestDatesMap = Record<string, number>;
export type HistoricalPricesMap = Record<string, TokenHistoricalPrices>;

/** Transaction shape from wallet context (timestamp in seconds from indexer) */
export interface TransactionLike {
  token: string;
  timestamp: number;
}

/**
 * Compute earliest timestamp (ms) per token from activity/transactions.
 */
export function getEarliestDatesFromTransactions(
  transactions: TransactionLike[]
): EarliestDatesMap {
  const byToken = new Map<string, number>();
  for (const tx of transactions) {
    const token = tx.token?.toLowerCase();
    if (!token) continue;
    const tsMs = tx.timestamp < 1e12 ? tx.timestamp * 1000 : tx.timestamp;
    const existing = byToken.get(token);
    if (existing === undefined || tsMs < existing) {
      byToken.set(token, tsMs);
    }
  }
  return Object.fromEntries(byToken);
}

/**
 * Load earliest token dates from AsyncStorage.
 */
export async function loadEarliestDates(): Promise<EarliestDatesMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_EARLIEST_DATES);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Save earliest token dates to AsyncStorage.
 */
export async function saveEarliestDates(dates: EarliestDatesMap): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY_EARLIEST_DATES, JSON.stringify(dates));
}

/**
 * Load historical price series per token from AsyncStorage.
 */
export async function loadHistoricalPrices(): Promise<HistoricalPricesMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_HISTORICAL_PRICES);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Save historical price series to AsyncStorage.
 */
export async function saveHistoricalPrices(
  prices: HistoricalPricesMap
): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEY_HISTORICAL_PRICES,
    JSON.stringify(prices)
  );
}

/**
 * Clear all historical price data from AsyncStorage (prices and earliest dates).
 * When EXPO_PUBLIC_CLEAR_PRICES is true, call this before sync so data is
 * reloaded from the API (100 days from today at midnight).
 */
export async function clearAllHistoricalPriceData(): Promise<void> {
  await AsyncStorage.multiRemove([
    STORAGE_KEY_HISTORICAL_PRICES,
    STORAGE_KEY_EARLIEST_DATES,
  ]);
}

/**
 * Merge new price points into existing series, sort by ts, dedupe, cap size.
 */
export function mergePriceSeries(
  existing: HistoricalPricePoint[],
  newPoints: HistoricalPricePoint[]
): HistoricalPricePoint[] {
  const byTs = new Map<number, number>();
  for (const p of existing) byTs.set(p.ts, p.price);
  for (const p of newPoints) byTs.set(p.ts, p.price);
  const merged = Array.from(byTs.entries())
    .map(([ts, price]) => ({ ts, price }))
    .sort((a, b) => a.ts - b.ts);
  if (merged.length <= MAX_POINTS_PER_TOKEN) return merged;
  return downscaleToMax(merged, MAX_POINTS_PER_TOKEN);
}

function downscaleToMax(
  sorted: HistoricalPricePoint[],
  max: number
): HistoricalPricePoint[] {
  if (sorted.length <= max) return sorted;
  const step = sorted.length / max;
  const result: HistoricalPricePoint[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.min(Math.floor(i * step), sorted.length - 1);
    result.push(sorted[idx]);
  }
  return result;
}

/**
 * AssetTicker to Bitfinex/API symbol (uppercase).
 */
export function assetTickerToSymbol(ticker: AssetTicker): string {
  return ticker.toUpperCase();
}

/**
 * Tokens we fetch historical data for (skip stablecoins if not needed for chart).
 */
export const HISTORICAL_PRICE_TOKENS: AssetTicker[] = [
  AssetTicker.BTC,
  AssetTicker.XAUT,
  // USDT/USAT are stable; optionally add if Bitfinex has series
];

export interface PricingServiceLike {
  getHistoricalPrice(opts: {
    from: AssetTicker;
    to: string;
    start?: number;
    end?: number;
    apiFromSymbol?: string;
  }): Promise<HistoricalPricePoint[]>;
}

/**
 * Sync earliest token dates from activity and historical price data.
 * - Computes earliest date per token from transactions, merges with stored dates, saves.
 * - For each token: only requests day ranges missing from stored data (from start through today at midnight), merges, saves.
 */
export async function syncHistoricalPrices(
  transactions: TransactionLike[],
  pricingService: PricingServiceLike
): Promise<void> {
  const nowMs = Date.now();
  const todayMidnightMs = dayMidnightMs(nowMs);
  const chartStartMs = nowMs - CHART_DAYS_MS;

  const fromActivity = getEarliestDatesFromTransactions(transactions);
  const storedDates = await loadEarliestDates();
  const mergedDates: EarliestDatesMap = { ...storedDates };
  for (const [token, ms] of Object.entries(fromActivity)) {
    const existing = mergedDates[token];
    if (existing === undefined || ms < existing) {
      mergedDates[token] = ms;
    }
  }
  await saveEarliestDates(mergedDates);

  const storedPrices = await loadHistoricalPrices();
  const updatedPrices: HistoricalPricesMap = { ...storedPrices };

  for (const ticker of HISTORICAL_PRICE_TOKENS) {
    const tokenKey = ticker.toLowerCase();
    // Chart USD bands need the full window of market prices, independent of activity.
    const startMs = chartStartMs;
    const existing = storedPrices[tokenKey]?.data ?? [];

    if (startMs >= todayMidnightMs + DAY_MS) continue;

    const ranges = missingDayRanges(existing, startMs, todayMidnightMs);
    if (ranges.length === 0) {
      continue;
    }

    let merged = existing;
    for (const range of ranges) {
      try {
        console.log('[HistoricalPrice] fetching missing range', {
          ticker,
          start: range.startMs,
          end: range.endMs,
          startDate: new Date(range.startMs).toISOString(),
          endDate: new Date(range.endMs).toISOString(),
        });
        const newPoints = await pricingService.getHistoricalPrice({
          from: ticker,
          to: 'USD',
          start: range.startMs,
          end: range.endMs,
        });
        merged = mergePriceSeries(merged, newPoints);
      } catch (err) {
        console.warn(`[HistoricalPrice] Failed to fetch ${ticker} range ${range.startMs}-${range.endMs}:`, err);
      }
    }
    updatedPrices[tokenKey] = {
      lastUpdated: nowMs,
      data: merged,
    };
  }

  await saveHistoricalPrices(updatedPrices);
  notifyHistoricalPricesUpdated();
}

/**
 * Ensure BTC/XAU₮ USD price history covers the chart window (last 100 days).
 * Fetches any missing ranges from the pricing service so holdings can be valued
 * even when activity does not date acquisitions.
 */
export async function ensureChartUsdPrices(
  stored: HistoricalPricesMap,
  pricingService: PricingServiceLike
): Promise<HistoricalPricesMap> {
  const nowMs = Date.now();
  const todayMidnightMs = dayMidnightMs(nowMs);
  const chartStartMs = nowMs - CHART_DAYS_MS;
  const updated: HistoricalPricesMap = { ...stored };
  let changed = false;

  for (const ticker of HISTORICAL_PRICE_TOKENS) {
    const tokenKey = ticker.toLowerCase();
    const existing = stored[tokenKey]?.data ?? [];
    const ranges = missingDayRanges(existing, chartStartMs, todayMidnightMs);
    if (ranges.length === 0) continue;

    let merged = existing;
    for (const range of ranges) {
      try {
        const newPoints = await pricingService.getHistoricalPrice({
          from: ticker,
          to: 'USD',
          start: range.startMs,
          end: range.endMs,
        });
        merged = mergePriceSeries(merged, newPoints);
        changed = true;
      } catch (err) {
        console.warn(
          `[HistoricalPrice] ensureChartUsdPrices failed ${ticker} ${range.startMs}-${range.endMs}:`,
          err
        );
      }
    }
    updated[tokenKey] = { lastUpdated: nowMs, data: merged };
  }

  if (changed) {
    await saveHistoricalPrices(updated);
    notifyHistoricalPricesUpdated();
  }
  return updated;
}


/** Token display colors for chart lines (hex); lighter values for better contrast on dark background */
export const TOKEN_CHART_COLORS: Record<string, string> = {
  btc: '#F7931A',
  xaut: '#D4AF37',
  usdt: '#3A6E56',
  usat: '#3A6E56',
  usd: '#3A6E56',
};

/** Vivid stroke colors for the indexed performance line chart on dark backgrounds. */
export const PERFORMANCE_LINE_COLORS: Record<string, string> = {
  btc: '#FF9200',
  xaut: '#FFCA00',
  usd: '#20E874',
  usdt: '#20E874',
  usat: '#20E874',
};

/** Legend order for the stacked holdings chart (bottom → top). */
export const HOLDING_STACK_LEGEND: Array<{ key: string; label: string }> = [
  { key: 'usd', label: 'USD' },
  { key: 'xaut', label: 'XAU₮' },
  { key: 'btc', label: 'BTC' },
];

function hexToRgba(hex: string, opacity = 1): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

/** Normalize indexer/provider token strings to chart balance keys. */
export function tokenToChartKey(token: string | undefined): string {
  const t = (token ?? '').toString().toLowerCase();
  if (t === 'xaut' || t === 'xau' || t.startsWith('xau')) return 'xaut';
  if (t === 'usat' || t === 'usa' || t.startsWith('usa')) return 'usat';
  if (t === 'usdt' || t.startsWith('usd')) return 'usdt';
  if (t === 'btc') return 'btc';
  return t;
}

const BALANCE_TOKEN_KEYS = ['btc', 'xaut', 'usdt', 'usat'] as const;

export interface ChartDataset {
  data: number[];
  color: (opacity?: number) => string;
  strokeWidth?: number;
}

export interface PriceChartData {
  labels: string[];
  datasets: ChartDataset[];
  legend?: string[];
}

/**
 * Build LineChart-ready data from stored historical prices.
 * - Restricts to last year of data.
 * - Builds a unified timeline (sorted unique timestamps); each token gets a value at each timestamp (nearest prior price).
 * - Labels are formatted dates; sample to avoid crowding (e.g. first, last, and a few in between).
 */
function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** Token keys used for the price line chart (BTC and XAUT only). */
const CHART_TOKEN_KEYS = ['btc', 'xaut'] as const;

/** Transaction shape for balance replay (timestamp in seconds or ms). */
export interface TransactionForBalance {
  timestamp: number;
  token: string;
  amount: number;
  from?: string;
  to?: string;
}

/**
 * Same sent/received logic as the wallet UI (getTransactions): sent when from is one of our addresses.
 * walletAddresses must be built the same way as the UI: Object.values(addresses).map(addr => addr?.toLowerCase()).
 */
export function isSentByWalletUI(
  from: string | undefined,
  walletAddresses: (string | undefined)[]
): boolean {
  const fromAddress = from?.toLowerCase();
  return walletAddresses.includes(fromAddress);
}

/**
 * Compute token balances (btc, xaut, usdt, usat) as of endOfDayMs by replaying transactions chronologically.
 * Uses the same balance logic as the wallet UI: isSentByWalletUI(tx.from, walletAddresses).
 * Sent subtracts, received adds. walletAddresses must match UI (Object.values(addresses).map(addr => addr?.toLowerCase())).
 */
export function getBalanceAsOfTimestamp(
  transactions: TransactionForBalance[],
  walletAddresses: (string | undefined)[],
  endOfDayMs: number
): Record<string, number> {
  const endMs = endOfDayMs < 1e12 ? endOfDayMs * 1000 : endOfDayMs;
  const sorted = [...transactions].sort((a, b) => {
    const ta = a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp;
    const tb = b.timestamp < 1e12 ? b.timestamp * 1000 : b.timestamp;
    return ta - tb;
  });
  const balance: Record<string, number> = { btc: 0, xaut: 0, usdt: 0, usat: 0 };
  for (const tx of sorted) {
    const tsMs = tx.timestamp < 1e12 ? tx.timestamp * 1000 : tx.timestamp;
    if (tsMs > endMs) break;
    const tokenKey = tokenToChartKey(tx.token);
    if (!(BALANCE_TOKEN_KEYS as readonly string[]).includes(tokenKey)) continue;
    const amount = Number(tx.amount) || 0;
    const isSent = isSentByWalletUI(tx.from, walletAddresses);
    const current = balance[tokenKey] ?? 0;
    if (amount < 0) {
      balance[tokenKey] = current + amount;
    } else {
      balance[tokenKey] = current + (isSent ? -amount : amount);
    }
  }
  return balance;
}

/** Snapshot of wallet holdings (human units) keyed by chart token. */
export type CurrentHoldings = Partial<Record<(typeof BALANCE_TOKEN_KEYS)[number], number>>;

/**
 * Balance for charting: replayed transfer history plus any holdings the indexer
 * never credited (treated as acquired before the chart window).
 */
function resolveChartBalance(
  tokenKey: string,
  replayed: number,
  undatedGap: number
): number {
  return Math.max(0, replayed + undatedGap);
}

function undatedHoldingGap(
  tokenKey: string,
  replayedToday: Record<string, number>,
  currentHoldings: CurrentHoldings
): number {
  const current = currentHoldings[tokenKey as keyof CurrentHoldings] ?? 0;
  const replayed = replayedToday[tokenKey] ?? 0;
  return Math.max(0, current - replayed);
}

function getPriceAt(
  points: { tsMs: number; price: number }[],
  tsMs: number
): number {
  if (points.length === 0) return 0;
  let i = 0;
  while (i < points.length && points[i].tsMs <= tsMs) i++;
  if (i === 0) return points[0].price;
  if (i >= points.length) return points[points.length - 1].price;
  const a = points[i - 1];
  const b = points[i];
  const t = (tsMs - a.tsMs) / (b.tsMs - a.tsMs);
  return a.price * (1 - t) + b.price * t;
}

function downsampleAligned<T>(items: T[], maxPoints: number): T[] {
  if (items.length <= maxPoints) return items;
  const step = (items.length - 1) / (maxPoints - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = i === maxPoints - 1 ? items.length - 1 : Math.round(i * step);
    out.push(items[idx]);
  }
  return out;
}

function makeChartDataset(
  data: number[],
  tokenKey: string,
  strokeWidth = 1,
  colors: Record<string, string> = TOKEN_CHART_COLORS,
  /** When set, ignores chart-kit's default stroke opacity (0.2 for bezier lines). */
  lineOpacity?: number
): ChartDataset {
  const hex = colors[tokenKey] ?? '#999';
  return {
    data,
    color:
      lineOpacity !== undefined
        ? () => hexToRgba(hex, lineOpacity)
        : (opacity = 1) => hexToRgba(hex, opacity),
    strokeWidth,
  };
}

/** Rebase a price series to 100 at the first positive sample (indexed performance). */
function toIndexed100(prices: number[]): number[] {
  const base = prices.find((p) => p > 0);
  if (!base) return prices.map(() => 100);
  return prices.map((p) => (p > 0 ? (p / base) * 100 : 100));
}

export type ChartStackToken = 'btc' | 'xaut' | 'usd';

/** Bottom → top band order for the stacked holdings chart. */
export const DEFAULT_CHART_STACK_ORDER: ChartStackToken[] = ['usd', 'xaut', 'btc'];

/** Move one token to the bottom; other tokens keep their relative order. */
export function moveTokenToChartStackBottom(
  order: readonly ChartStackToken[],
  token: ChartStackToken
): ChartStackToken[] {
  const rest = order.filter((t) => t !== token);
  return [token, ...rest];
}

/** Quote unit for holdings chart denomination (same tokens as stack bands). */
export type ChartQuoteUnit = ChartStackToken;

export const DEFAULT_CHART_QUOTE_UNIT: ChartQuoteUnit = 'usd';

function toQuoteUnits(
  btcUsd: number,
  xautUsd: number,
  usdUsd: number,
  btcPrice: number,
  xautPrice: number,
  quote: ChartQuoteUnit
): PortfolioDayValues {
  if (quote === 'usd') {
    return { btc: btcUsd, xaut: xautUsd, usd: usdUsd };
  }
  const divisor = quote === 'btc' ? btcPrice : xautPrice;
  if (divisor <= 0) {
    return { btc: 0, xaut: 0, usd: 0 };
  }
  return {
    btc: btcUsd / divisor,
    xaut: xautUsd / divisor,
    usd: usdUsd / divisor,
  };
}

/** Spot prices for each asset expressed in the chosen quote unit (for performance indexing). */
function toPerformancePricesInQuote(
  btcPrice: number,
  xautPrice: number,
  quote: ChartQuoteUnit
): PortfolioDayValues {
  if (quote === 'usd') {
    return { btc: btcPrice, xaut: xautPrice, usd: 1 };
  }
  if (quote === 'btc') {
    if (btcPrice <= 0) return { btc: 1, xaut: 0, usd: 0 };
    return { btc: 1, xaut: xautPrice / btcPrice, usd: 1 / btcPrice };
  }
  if (xautPrice <= 0) return { btc: 0, xaut: 1, usd: 0 };
  return { btc: btcPrice / xautPrice, xaut: 1, usd: 1 / xautPrice };
}

type PortfolioDayValues = { btc: number; xaut: number; usd: number };

function buildStackedDatasetsFromDayValues(
  days: PortfolioDayValues[],
  stackOrder: readonly ChartStackToken[]
): ChartDataset[] {
  const order = stackOrder.length === 3 ? stackOrder : DEFAULT_CHART_STACK_ORDER;
  const cumulativeByDay = days.map((d) => {
    let cum = 0;
    return order.map((key) => {
      cum += d[key];
      return cum;
    });
  });

  // react-native-chart-kit fills each series to the baseline; paint top → bottom (back → front).
  const datasets: ChartDataset[] = [];
  for (let layer = order.length - 1; layer >= 0; layer--) {
    const tokenKey = order[layer];
    const data = cumulativeByDay.map((cums) => cums[layer]);
    datasets.push(makeChartDataset(data, tokenKey));
  }
  return datasets;
}

/**
 * Stacked holding value over time in the chosen quote unit (USD, BTC, or XAU₮).
 * Values are derived from USD notionals using daily BTC/XAU₮ prices as the pivot.
 */
export function buildPortfolioValueChartData(
  stored: HistoricalPricesMap,
  transactions: TransactionForBalance[],
  walletAddresses: string[],
  maxPoints = 80,
  currentHoldings: CurrentHoldings = {},
  stackOrder: readonly ChartStackToken[] = DEFAULT_CHART_STACK_ORDER,
  quoteUnit: ChartQuoteUnit = DEFAULT_CHART_QUOTE_UNIT
): PriceChartData | null {
  const nowMs = Date.now();
  const todayMidnightMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const chartStartMs = Math.floor((nowMs - CHART_DAYS_MS) / DAY_MS) * DAY_MS;

  const toSortedPrices = (key: string) =>
    (stored[key]?.data ?? [])
      .map((p) => ({ ...p, tsMs: toMs(p.ts) }))
      .sort((a, b) => a.tsMs - b.tsMs);

  const btcSorted = toSortedPrices('btc');
  const xautSorted = toSortedPrices('xaut');
  const endOfTodayMs = todayMidnightMs + DAY_MS - 1;
  const replayedToday = getBalanceAsOfTimestamp(
    transactions,
    walletAddresses,
    endOfTodayMs
  );
  const btcGap = undatedHoldingGap('btc', replayedToday, currentHoldings);
  const xautGap = undatedHoldingGap('xaut', replayedToday, currentHoldings);
  const usdtGap = undatedHoldingGap('usdt', replayedToday, currentHoldings);
  const usatGap = undatedHoldingGap('usat', replayedToday, currentHoldings);

  type DayPoint = PortfolioDayValues & { tsMs: number; total: number };
  const days: DayPoint[] = [];
  for (let dayMs = chartStartMs; dayMs <= todayMidnightMs; dayMs += DAY_MS) {
    const endOfDayMs = dayMs + DAY_MS - 1;
    const replayed = getBalanceAsOfTimestamp(transactions, walletAddresses, endOfDayMs);
    const btcBal = resolveChartBalance('btc', replayed.btc ?? 0, btcGap);
    const xautBal = resolveChartBalance('xaut', replayed.xaut ?? 0, xautGap);
    const usdtBal = resolveChartBalance('usdt', replayed.usdt ?? 0, usdtGap);
    const usatBal = resolveChartBalance('usat', replayed.usat ?? 0, usatGap);
    const btcPrice = getPriceAt(btcSorted, dayMs);
    const xautPrice = getPriceAt(xautSorted, dayMs);
    const btcUsd = Math.max(0, btcBal * btcPrice);
    const xautUsd = Math.max(0, xautBal * xautPrice);
    const usdUsd = Math.max(0, usdtBal + usatBal);
    const quoted = toQuoteUnits(btcUsd, xautUsd, usdUsd, btcPrice, xautPrice, quoteUnit);
    const total = quoted.btc + quoted.xaut + quoted.usd;
    days.push({ tsMs: dayMs, ...quoted, total });
  }

  const firstIdx = days.findIndex((d) => d.total > 0);
  if (firstIdx < 0) return null;
  let used = downsampleAligned(days.slice(firstIdx), maxPoints);
  if (used.length === 1) {
    used = [used[0], { ...used[0], tsMs: used[0].tsMs + DAY_MS }];
  }

  const labels = used.map((d) => {
    const date = new Date(d.tsMs);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  });

  console.log('[PortfolioChart] stacked holdings:', used.length, 'points, quote:', quoteUnit);

  return {
    labels,
    datasets: buildStackedDatasetsFromDayValues(used, stackOrder),
  };
}

/**
 * Indexed price performance (rebased to 100) for BTC, XAU₮, and USD over the same 100-day
 * window, with all series expressed in the chosen quote unit.
 */
export function buildIndexedPerformanceChartData(
  stored: HistoricalPricesMap,
  maxPoints = 80,
  quoteUnit: ChartQuoteUnit = DEFAULT_CHART_QUOTE_UNIT
): PriceChartData | null {
  const nowMs = Date.now();
  const todayMidnightMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const chartStartMs = Math.floor((nowMs - CHART_DAYS_MS) / DAY_MS) * DAY_MS;

  const toSortedPrices = (key: string) =>
    (stored[key]?.data ?? [])
      .map((p) => ({ ...p, tsMs: toMs(p.ts) }))
      .sort((a, b) => a.tsMs - b.tsMs);

  const btcSorted = toSortedPrices('btc');
  const xautSorted = toSortedPrices('xaut');
  if (btcSorted.length === 0 && xautSorted.length === 0) return null;

  type DayPoint = { tsMs: number; btc: number; xaut: number; usd: number };
  const days: DayPoint[] = [];
  for (let dayMs = chartStartMs; dayMs <= todayMidnightMs; dayMs += DAY_MS) {
    const btcPrice = getPriceAt(btcSorted, dayMs);
    const xautPrice = getPriceAt(xautSorted, dayMs);
    const quoted = toPerformancePricesInQuote(btcPrice, xautPrice, quoteUnit);
    days.push({ tsMs: dayMs, ...quoted });
  }

  let used = downsampleAligned(days, maxPoints);
  if (used.length === 1) {
    used = [used[0], { ...used[0], tsMs: used[0].tsMs + DAY_MS }];
  }

  const labels = used.map((d) => {
    const date = new Date(d.tsMs);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  });

  const btcIndexed = toIndexed100(used.map((d) => d.btc));
  const xautIndexed = toIndexed100(used.map((d) => d.xaut));
  const usdIndexed = toIndexed100(used.map((d) => d.usd));

  return {
    labels,
    datasets: [
      makeChartDataset(btcIndexed, 'btc', 3, PERFORMANCE_LINE_COLORS, 0.5),
      makeChartDataset(xautIndexed, 'xaut', 3, PERFORMANCE_LINE_COLORS, 0.5),
      makeChartDataset(usdIndexed, 'usd', 3, PERFORMANCE_LINE_COLORS, 0.5),
    ],
  };
}

export function buildPriceChartData(
  stored: HistoricalPricesMap,
  maxPoints = 80,
  tokenFilter?: readonly string[]
): PriceChartData | null {
  const keys = tokenFilter ?? CHART_TOKEN_KEYS;
  const tokenKeys = keys.filter((k) => stored[k]?.data?.length);
  if (tokenKeys.length === 0) return null;

  const nowMs = Date.now();
  const chartStartMs = nowMs - CHART_DAYS_MS;
  const allTs: number[] = [];
  for (const key of tokenKeys) {
    for (const p of stored[key].data) {
      const tsMs = toMs(p.ts);
      allTs.push(tsMs);
    }
  }
  const uniqueTs = Array.from(new Set(allTs))
    .filter((ts) => ts >= chartStartMs)
    .sort((a, b) => a - b);
  if (uniqueTs.length === 0) return null;

  let sortedTs =
    uniqueTs.length <= maxPoints
      ? uniqueTs
      : (() => {
          const step = (uniqueTs.length - 1) / (maxPoints - 1);
          const out: number[] = [];
          for (let i = 0; i < maxPoints; i++) {
            const idx =
              i === maxPoints - 1 ? uniqueTs.length - 1 : Math.round(i * step);
            out.push(uniqueTs[idx]);
          }
          return out;
        })();

  if (sortedTs.length === 1) {
    sortedTs = [sortedTs[0], sortedTs[0] + DAY_MS];
  }

  const labels = sortedTs.map((ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });

  const datasets: ChartDataset[] = [];
  const legend: string[] = [];

  for (const tokenKey of tokenKeys) {
    const rawPoints = stored[tokenKey].data
      .map((p) => ({ ...p, tsMs: toMs(p.ts) }))
      .filter((p) => p.tsMs >= chartStartMs)
      .sort((a, b) => a.tsMs - b.tsMs);
    if (rawPoints.length === 0) continue;

    const data = sortedTs.map((ts) => {
      let i = 0;
      while (i < rawPoints.length && rawPoints[i].tsMs <= ts) i++;
      if (i === 0) return rawPoints[0].price;
      if (i >= rawPoints.length) return rawPoints[rawPoints.length - 1].price;
      const a = rawPoints[i - 1];
      const b = rawPoints[i];
      const t = (ts - a.tsMs) / (b.tsMs - a.tsMs);
      return a.price * (1 - t) + b.price * t;
    });

    const hex = TOKEN_CHART_COLORS[tokenKey] ?? '#999';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    datasets.push({
      data,
      color: (opacity = 1) => `rgba(${r},${g},${b},${opacity})`,
      strokeWidth: 3,
    });
    legend.push(tokenKey.toUpperCase());
  }

  if (datasets.length === 0) return null;
  return { labels, datasets, legend };
}
