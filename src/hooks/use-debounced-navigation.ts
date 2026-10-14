import { useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

/**
 * Ignores a second navigation tap within `delay` ms.
 * The window is checked against the clock on each press, so a missed timer
 * cannot leave the main screen's buttons stuck after a later screen stalls.
 */
export function useDebouncedNavigation(delay = 300) {
  const router = useRouter();
  const lastNavigationAtRef = useRef(0);

  const run = useCallback(
    (action: () => void) => {
      const now = Date.now();
      if (now - lastNavigationAtRef.current < delay) {
        return;
      }
      lastNavigationAtRef.current = now;
      action();
    },
    [delay]
  );

  const push = useCallback(
    (path: string | { pathname: string; params?: Record<string, any> }) => {
      run(() => {
        router.push(path as any);
      });
    },
    [router, run]
  );

  const replace = useCallback(
    (path: string | { pathname: string; params?: Record<string, any> }) => {
      run(() => {
        router.replace(path as any);
      });
    },
    [router, run]
  );

  const back = useCallback(() => {
    run(() => {
      router.back();
    });
  }, [router, run]);

  const dismissAll = useCallback(
    (navigateTo?: string | { pathname: string; params?: Record<string, any> }) => {
      run(() => {
        router.dismissAll();
        if (navigateTo) {
          router.replace(navigateTo as any);
        }
      });
    },
    [router, run]
  );

  const dismissTo = useCallback(
    (path: string | { pathname: string; params?: Record<string, any> }) => {
      run(() => {
        router.dismissTo(path as any);
      });
    },
    [router, run]
  );

  return { push, replace, back, dismissAll, dismissTo };
}
