import AsyncStorage from '@react-native-async-storage/async-storage';

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

export function isSpacesListCacheStale(
  cachedAt: number | null,
  now = Date.now()
): boolean {
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

async function fetchGetSpacesOnce(
  baseUrl: string,
  appName: string
): Promise<FetchGetSpacesOnceResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/getspaces?app=${encodeURIComponent(appName)}`;
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const duration = Date.now() - startTime;
    const text = await response.text();

    if (!response.ok) {
      console.error(
        `[Spaces API] GET ${url} - HTTP error! status: ${response.status} (${duration}ms)`
      );
      const retryable =
        response.status >= 500 || response.status === 408 || response.status === 429;
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
      return {
        ok: false,
        retryable: false,
        status: response.status,
        errorMessage: 'Invalid response from Spaces server.',
      };
    }

    if (!data.spaces || !Array.isArray(data.spaces)) {
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

    if (__DEV__) {
      console.log(
        `[Spaces API] GET getspaces - Success (${duration}ms), count=${spaceNames.length}`
      );
    }
    return { ok: true, spaceNames };
  } catch (error) {
    const duration = Date.now() - startTime;
    const isTimeout =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    const isNetwork = error instanceof TypeError;

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
    clearTimeout(timer);
  }
}

export async function fetchSpaceNameOptionsWithRetry(
  baseUrl: string,
  appName: string,
  options?: { maxAttempts?: number }
): Promise<{ ok: true; spaceNames: string[] } | { ok: false; errorMessage: string }> {
  const maxAttempts = options?.maxAttempts ?? GETSPACES_MAX_ATTEMPTS;
  let lastError = 'Unable to load spaces list.';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchGetSpacesOnce(baseUrl, appName);
    if (result.ok) {
      await writeCachedSpaceNames(result.spaceNames);
      return { ok: true, spaceNames: result.spaceNames };
    }

    lastError = result.errorMessage;
    if (!result.retryable || attempt >= maxAttempts) {
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
