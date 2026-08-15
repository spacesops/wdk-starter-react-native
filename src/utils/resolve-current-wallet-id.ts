/**
 * Resolve the active wallet id for hooks.
 * Returns undefined when no wallet is known yet — never uses core's placeholder
 * `{ identifier: "default", exists: false }` list row, which would trigger
 * WalletSwitchingService against a missing keychain entry.
 */
export function resolveCurrentWalletId(
  activeWalletId: string | null | undefined,
  wallets: ReadonlyArray<{ identifier: string; exists?: boolean }>
): string | undefined {
  if (activeWalletId) return activeWalletId;
  return wallets.find((wallet) => wallet.exists === true)?.identifier;
}
