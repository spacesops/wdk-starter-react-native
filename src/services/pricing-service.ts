import { AssetTicker } from '@/config/assets';
import { loadHistoricalPrices } from '@/services/historical-price-storage';
import DecimalJS from 'decimal.js';

/** Inlined at build time from EXPO_PUBLIC_SPACES_API_BASE_URL (must use direct process.env access). */
const SPACES_API_BASE_URL =
  process.env.EXPO_PUBLIC_SPACES_API_BASE_URL || 'http://192.168.1.111:7264';

function getSpacesApiBaseUrl(): string {
  return SPACES_API_BASE_URL;
}

export function getPricingServiceHostname(): string {
  try {
    const base = getSpacesApiBaseUrl();
    if (base) {
      const url = new URL(base);
      return url.hostname || base;
    }
  } catch {
    // ignore and fall through
  }
  return 'pricing service';
}

export enum FiatCurrency {
  USD = 'USD',
}

/** AssetTicker to Spaces API price slug (from env: EXPO_PUBLIC_PRICE_SLUG_*). */
function assetTickerToSlug(ticker: AssetTicker): string | null {
  switch (ticker) {
    case AssetTicker.BTC:
      return process.env.EXPO_PUBLIC_PRICE_SLUG_BTC ?? 'bitcoin';
    case AssetTicker.XAUT:
      return process.env.EXPO_PUBLIC_PRICE_SLUG_XAUT ?? 'tether-gold';
    default:
      return null;
  }
}

const DAY_MS = 86400000;
const DAY_SEC = 86400;

/**
 * Convert a time range (ms) to from/to as midnight UTC (seconds) for the API.
 * from = midnight UTC of the day containing startMs, to = midnight UTC of the day after endMs.
 */
function toMidnightUTCRange(startMs: number, endMs: number): { fromSec: number; toSec: number } {
  const fromDay = Math.floor(startMs / DAY_MS);
  const toDay = Math.floor(endMs / DAY_MS);
  const fromSec = fromDay * DAY_SEC;
  const toSec = (toDay + 1) * DAY_SEC;
  return { fromSec, toSec };
}

/**
 * Parse timestamp from API point. Handles:
 * - timestamp_sec (Spaces API: unix seconds)
 * - ts, timestamp, time (unix seconds or ms)
 * - date (YYYY-MM-DD string) → midnight UTC in ms
 */
function parsePointTs(
  p: {
    timestamp_sec?: number;
    ts?: number;
    timestamp?: number;
    time?: number;
    date?: string;
  }
): number {
  const sec =
    p.timestamp_sec ?? p.ts ?? p.timestamp ?? p.time;
  if (sec != null && typeof sec === 'number') {
    return sec < 1e12 ? sec * 1000 : sec;
  }
  const dateStr = p.date;
  if (typeof dateStr === 'string') {
    const ms = Date.UTC(
      parseInt(dateStr.slice(0, 4), 10),
      parseInt(dateStr.slice(5, 7), 10) - 1,
      parseInt(dateStr.slice(8, 10), 10)
    );
    return ms;
  }
  return 0;
}

/** Normalize API response to { price, ts } with ts in milliseconds. */
function normalizePriceSeries(
  raw: Array<{
    price: number;
    timestamp_sec?: number;
    ts?: number;
    timestamp?: number;
    time?: number;
    date?: string;
  }>
): Array<{ price: number; ts: number }> {
  return raw.map((p) => ({
    price: Number(p.price),
    ts: parsePointTs(p),
  }));
}

async function fetchPricesFromApi(
  slug: string,
  fromSec: number,
  toSec: number
): Promise<Array<{ price: number; ts: number }>> {
  const baseUrl = getSpacesApiBaseUrl();
  const url = `${baseUrl}/prices/${slug}/?format=json&from=${fromSec}&to=${toSec}`;
  console.log('[PricingService] full pricing URL:', url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Spaces prices API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const arr = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
  return normalizePriceSeries(arr);
}

function latestStoredPrice(
  points: Array<{ price: number; ts: number }> | undefined
): number | null {
  if (!points?.length) return null;
  let best: { price: number; ts: number } | null = null;
  for (const point of points) {
    if (!Number.isFinite(point.price) || point.price <= 0) continue;
    if (best == null || point.ts >= best.ts) best = point;
  }
  return best?.price ?? null;
}

class PricingService {
  private static instance: PricingService;
  private fiatExchangeRateCache: Record<FiatCurrency, Record<AssetTicker, number>> | undefined;
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private rateListeners = new Set<() => void>();

  private constructor() {}

  static getInstance(): PricingService {
    if (!PricingService.instance) {
      PricingService.instance = new PricingService();
    }
    return PricingService.instance;
  }

  private applyRates(btc: number, xaut: number): void {
    this.fiatExchangeRateCache = {
      [FiatCurrency.USD]: {
        [AssetTicker.BTC]: btc,
        [AssetTicker.USDT]: 1,
        [AssetTicker.XAUT]: xaut,
        [AssetTicker.USAT]: 1,
      },
    };
    this.isInitialized = true;
    this.rateListeners.forEach((listener) => listener());
  }

  /** Fires after spot rates are seeded from cache or replaced by a network refresh. */
  subscribeToExchangeRates(listener: () => void): () => void {
    this.rateListeners.add(listener);
    return () => {
      this.rateListeners.delete(listener);
    };
  }

  private async fetchLastPriceForSlug(slug: string): Promise<number> {
    const nowMs = Date.now();
    const { fromSec, toSec } = toMidnightUTCRange(nowMs, nowMs);
    let points = await fetchPricesFromApi(slug, fromSec, toSec);
    if (points.length === 0) {
      const yesterdayMs = nowMs - DAY_MS;
      const { fromSec: prevFrom, toSec: prevTo } = toMidnightUTCRange(yesterdayMs, yesterdayMs);
      points = await fetchPricesFromApi(slug, prevFrom, prevTo);
    }
    if (points.length === 0) {
      throw new Error(`No price data from Spaces API for /prices/${slug}/`);
    }
    const last = points[points.length - 1];
    return last.price;
  }

  private async fetchSpotRates(): Promise<{ btc: number; xaut: number }> {
    const btcSlug = assetTickerToSlug(AssetTicker.BTC);
    const xautSlug = assetTickerToSlug(AssetTicker.XAUT);
    const [btcResult, xautResult] = await Promise.allSettled([
      btcSlug != null ? this.fetchLastPriceForSlug(btcSlug) : Promise.resolve(0),
      xautSlug != null ? this.fetchLastPriceForSlug(xautSlug) : Promise.resolve(0),
    ]);

    if (btcResult.status === 'rejected') {
      console.error('Failed to fetch BTC price:', btcResult.reason);
    }
    if (xautResult.status === 'rejected') {
      console.error('Failed to fetch XAU₮ price:', xautResult.reason);
    }
    if (btcResult.status === 'rejected' && xautResult.status === 'rejected') {
      throw btcResult.reason;
    }

    return {
      btc:
        btcResult.status === 'fulfilled'
          ? btcResult.value
          : (this.getExchangeRate(AssetTicker.BTC, FiatCurrency.USD) ?? 0),
      xaut:
        xautResult.status === 'fulfilled'
          ? xautResult.value
          : (this.getExchangeRate(AssetTicker.XAUT, FiatCurrency.USD) ?? 0),
    };
  }

  /** Use the newest stored chart point so USD values can render before a network round trip. */
  private async seedFromStoredHistory(): Promise<boolean> {
    const stored = await loadHistoricalPrices();
    const btc = latestStoredPrice(stored.btc?.data);
    const xaut = latestStoredPrice(stored.xaut?.data);
    if (btc == null && xaut == null) return false;
    this.applyRates(btc ?? 0, xaut ?? 0);
    return true;
  }

  private async doInitialize(): Promise<void> {
    const seeded = await this.seedFromStoredHistory();
    if (seeded) {
      void this.refreshExchangeRates().catch(() => {});
      return;
    }

    const { btc, xaut } = await this.fetchSpotRates();
    this.applyRates(btc, xaut);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((error) => {
        this.initPromise = null;
        console.error('Failed to initialize pricing service:', error);
        throw error;
      });
    }
    return this.initPromise;
  }

  async getFiatValue(value: number, asset: AssetTicker, currency: FiatCurrency): Promise<number> {
    if (!this.isInitialized || !this.fiatExchangeRateCache) {
      return 0;
    }
    const rate = this.fiatExchangeRateCache[currency][asset];
    if (rate == null) return 0;
    return new DecimalJS(value).mul(rate).toNumber();
  }

  async refreshExchangeRates(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Pricing service not initialized');
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.fetchSpotRates()
      .then(({ btc, xaut }) => {
        this.applyRates(btc, xaut);
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  getExchangeRate(asset: AssetTicker, currency: FiatCurrency): number | undefined {
    return this.fiatExchangeRateCache?.[currency]?.[asset];
  }

  /**
   * Fetch historical price series from Spaces API (/prices/{slug}/?format=json&from=&to=).
   * start/end are in milliseconds; API expects unix seconds.
   */
  async getHistoricalPrice(opts: {
    from: AssetTicker;
    to: FiatCurrency;
    start?: number;
    end?: number;
    /** Override slug sent to API (e.g. from env or custom mapping). */
    apiFromSymbol?: string;
  }): Promise<{ price: number; ts: number }[]> {
    const slug =
      opts.apiFromSymbol ?? assetTickerToSlug(opts.from) ?? opts.from.toLowerCase();
    const nowMs = Date.now();
    const startMs = opts.start ?? nowMs - DAY_MS;
    const endMs = opts.end ?? nowMs;
    const { fromSec, toSec } = toMidnightUTCRange(startMs, endMs);

    console.log('[PricingService] getHistoricalPrice', {
      slug,
      assetTicker: opts.from,
      start: opts.start,
      end: opts.end,
      fromSec,
      toSec,
    });

    return fetchPricesFromApi(slug, fromSec, toSec);
  }

  isReady(): boolean {
    return this.isInitialized;
  }
}

export const pricingService = PricingService.getInstance();
