import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

export const GETSPACES_LIST_CACHE_KEY = 'spaces_wallet_getspaces_list_v1';
const FETCH_TIMEOUT_MS = 15_000;

export const GETSPACES_MAX_ATTEMPTS = 3;

/** Reuse cached list without a network call when younger than this. */
export const GETSPACES_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

export type CachedSpaceNamesEntry = {
  spaceNames: string[];
  cachedAt: number | null;
};

export type SpacesLoadStatus = 'loading' | 'ready' | 'error';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSpacesListCacheStale(cachedAt: number | null, now = Date.now()): boolean {
  if (cachedAt == null || !Number.isFinite(cachedAt)) {
    return true;
  }
  return now - cachedAt >= GETSPACES_CACHE_MAX_AGE_MS;
}

export async function readCachedSpaceNamesEntry(): Promise<CachedSpaceNamesEntry> {
  try {
    const raw = await AsyncStorage.getItem(GETSPACES_LIST_CACHE_KEY);
    if (!raw) {
      return { spaceNames: [], cachedAt: null };
    }
    const parsed = JSON.parse(raw) as { spaceNames?: unknown; cachedAt?: unknown };
    if (!Array.isArray(parsed.spaceNames)) {
      return { spaceNames: [], cachedAt: null };
    }
    const spaceNames = parsed.spaceNames.filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    );
    const cachedAt =
      typeof parsed.cachedAt === 'number' && Number.isFinite(parsed.cachedAt)
        ? parsed.cachedAt
        : null;
    return { spaceNames, cachedAt };
  } catch {
    return { spaceNames: [], cachedAt: null };
  }
}

export async function readCachedSpaceNames(): Promise<string[]> {
  const entry = await readCachedSpaceNamesEntry();
  return entry.spaceNames;
}

export async function writeCachedSpaceNames(spaceNames: string[]): Promise<void> {
  await AsyncStorage.setItem(
    GETSPACES_LIST_CACHE_KEY,
    JSON.stringify({ spaceNames, cachedAt: Date.now() })
  );
}

function errorMessageForHttpStatus(status: number): string {
  if (status === 400) {
    return 'Invalid request loading spaces list.';
  }
  if (status === 404) {
    return 'Spaces app configuration was not found on the server.';
  }
  if (status === 408 || status === 429) {
    return 'Spaces server is busy. Please try again.';
  }
  if (status >= 500) {
    return 'Spaces server is temporarily unavailable.';
  }
  return `Could not load spaces list (HTTP ${status}).`;
}

type FetchGetSpacesOnceResult =
  | { ok: true; spaceNames: string[] }
  | { ok: false; retryable: boolean; status: number; errorMessage: string };

type RawGetResponse = { status: number; text: string };

const GETSPACES_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function timeoutError(): Error {
  const error = new Error('Timeout');
  error.name = 'TimeoutError';
  return error;
}

type SpacesHttpRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
};

/**
 * iOS RCTNetworking + fetch AbortSignal can leave the response body pending even after the
 * server returns 200. XMLHttpRequest uses a separate path and reliably delivers responseText.
 */
function readSpacesViaXhr(
  url: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  request: SpacesHttpRequest = {}
): Promise<RawGetResponse> {
  const method = request.method ?? 'GET';
  const headers = request.headers ?? {};

  return new Promise((resolve, reject) => {
    if (externalSignal?.aborted) {
      reject(abortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      externalSignal?.removeEventListener('abort', onExternalAbort);
      handler();
    };

    const onExternalAbort = () => {
      xhr.abort();
    };

    externalSignal?.addEventListener('abort', onExternalAbort);

    xhr.open(method, url);
    for (const [header, value] of Object.entries(headers)) {
      xhr.setRequestHeader(header, value);
    }
    xhr.responseType = 'text';
    xhr.timeout = timeoutMs;

    xhr.onload = () => {
      finish(() => resolve({ status: xhr.status, text: xhr.responseText ?? '' }));
    };
    xhr.onerror = () => {
      finish(() => reject(new TypeError('Network request failed')));
    };
    xhr.ontimeout = () => {
      finish(() => reject(timeoutError()));
    };
    xhr.onabort = () => {
      finish(() => {
        if (externalSignal?.aborted) {
          reject(abortError());
        } else {
          reject(timeoutError());
        }
      });
    };

    xhr.send(request.body ?? null);
  });
}

async function readSpacesViaFetch(
  url: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  request: SpacesHttpRequest = {}
): Promise<RawGetResponse> {
  const method = request.method ?? 'GET';
  const headers = request.headers ?? {};
  const body = request.body;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/** Wait for the /getspaces body, then parse space_name. */
async function readGetSpaces(
  url: string,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<RawGetResponse> {
  const request: SpacesHttpRequest = { method: 'GET', headers: GETSPACES_HEADERS };
  if (Platform.OS === 'ios') {
    return readSpacesViaXhr(url, timeoutMs, externalSignal, request);
  }
  return readSpacesViaFetch(url, timeoutMs, externalSignal, request);
}

export type ReadSpacesApiRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Spaces API HTTP with iOS XHR transport for reliable response bodies. */
export async function readSpacesApiRequest(
  url: string,
  options: ReadSpacesApiRequestOptions = {}
): Promise<{ status: number; text: string }> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const request: SpacesHttpRequest = {
    method: options.method ?? 'GET',
    headers: options.headers ?? (options.method && options.method !== 'GET' ? {} : GETSPACES_HEADERS),
    body: options.body ?? null,
  };
  if (Platform.OS === 'ios') {
    return readSpacesViaXhr(url, timeoutMs, options.signal, request);
  }
  return readSpacesViaFetch(url, timeoutMs, options.signal, request);
}

/** GET with iOS XHR transport; use for quote/availability JSON endpoints. */
export async function readSpacesApiGet(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<{ status: number; text: string }> {
  return readSpacesApiRequest(url, { timeoutMs, signal: externalSignal });
}

async function fetchGetSpacesOnce(
  baseUrl: string,
  appName: string,
  externalSignal?: AbortSignal,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<FetchGetSpacesOnceResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/getspaces?app=${encodeURIComponent(appName)}&_=${Date.now()}`;
  const startTime = Date.now();

  if (externalSignal?.aborted) {
    return { ok: false, retryable: false, status: 0, errorMessage: 'Aborted' };
  }

  let outcome = 'threw';

  try {
    const transport = Platform.OS === 'ios' ? 'xhr' : 'fetch';
    console.log(`[Spaces API] GET getspaces - start (${transport}) ${url}`);
    const { status, text } = await readGetSpaces(url, timeoutMs, externalSignal);

    const duration = Date.now() - startTime;
    const response = { ok: status >= 200 && status < 300, status, text };

    if (!response.ok) {
      console.error(
        `[Spaces API] GET ${url} - HTTP error! status: ${response.status} (${duration}ms)`
      );
      const retryable =
        response.status >= 500 || response.status === 408 || response.status === 429;
      outcome = `HTTP ${response.status}`;
      return {
        ok: false,
        retryable,
        status: response.status,
        errorMessage: errorMessageForHttpStatus(response.status),
      };
    }

    let data: { spaces?: { space_name?: string }[] };
    try {
      data = text ? (JSON.parse(text) as { spaces?: { space_name?: string }[] }) : {};
    } catch {
      outcome = 'invalid JSON';
      return {
        ok: false,
        retryable: false,
        status: response.status,
        errorMessage: 'Invalid response from Spaces server.',
      };
    }

    if (!data.spaces || !Array.isArray(data.spaces)) {
      outcome = 'missing spaces field';
      return {
        ok: false,
        retryable: false,
        status: response.status,
        errorMessage: 'Spaces list missing from server response.',
      };
    }

    const spaceNames = data.spaces
      .map((item) => item.space_name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);

    outcome = `success, count=${spaceNames.length}`;
    return { ok: true, spaceNames };
  } catch (error) {
    const duration = Date.now() - startTime;
    const isUserAbort = externalSignal?.aborted === true;
    const isTimeout =
      !isUserAbort &&
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    const isNetwork = !isUserAbort && error instanceof TypeError;

    if (isUserAbort) {
      outcome = 'aborted by caller';
      return { ok: false, retryable: false, status: 0, errorMessage: 'Aborted' };
    }
    outcome = isTimeout
      ? `timed out after ${timeoutMs}ms`
      : isNetwork
        ? 'network failure'
        : 'failed';

    if (isNetwork) {
      console.error(
        `[Spaces API] GET ${url} - Network failure (${duration}ms):`,
        error instanceof Error ? error.message : error
      );
    } else {
      console.error(`[Spaces API] GET ${url} - Failed (${duration}ms):`, error);
    }

    return {
      ok: false,
      retryable: true,
      status: 0,
      errorMessage: isTimeout
        ? 'Loading spaces timed out. Please try again.'
        : isNetwork
          ? 'Unable to reach the Spaces server. Check your connection.'
          : 'Unable to load spaces list.',
    };
  } finally {
    console.log(`[Spaces API] GET getspaces - complete: ${outcome} (${Date.now() - startTime}ms)`);
  }
}

export async function fetchSpaceNameOptionsWithRetry(
  baseUrl: string,
  appName: string,
  options?: { maxAttempts?: number; signal?: AbortSignal; timeoutMs?: number }
): Promise<{ ok: true; spaceNames: string[] } | { ok: false; errorMessage: string }> {
  const maxAttempts = options?.maxAttempts ?? GETSPACES_MAX_ATTEMPTS;
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS;
  let lastError = 'Unable to load spaces list.';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      return { ok: false, errorMessage: 'Aborted' };
    }

    const result = await fetchGetSpacesOnce(baseUrl, appName, signal, timeoutMs);
    if (result.ok) {
      writeCachedSpaceNames(result.spaceNames).catch((error) => {
        console.warn('[Spaces API] Failed to cache getspaces list:', error);
      });
      return { ok: true, spaceNames: result.spaceNames };
    }

    lastError = result.errorMessage;
    if (lastError === 'Aborted' || !result.retryable || attempt >= maxAttempts) {
      return { ok: false, errorMessage: lastError };
    }

    const backoffMs = 1000 * (1 << (attempt - 1));
    if (__DEV__) {
      console.log(
        `[Spaces API] GET getspaces: retry in ${backoffMs}ms (${attempt}/${maxAttempts})`
      );
    }
    await delay(backoffMs);
  }

  return { ok: false, errorMessage: lastError };
}
