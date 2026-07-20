/** Fields used to derive the My Spaces / subspace detail status label. */
export type MySpaceStatusInput = {
  status?: string;
  chainPresence?: 'on-chain' | 'off-chain';
  subsHandleStatus?: string | null;
  subsCommitmentRootConfirming?: boolean;
  subsPipelineBatchConfirming?: boolean;
  tenantQuotePaymentConfirmed?: boolean | null;
};

const UNIFIED_STATUS_LABELS: Record<string, string> = {
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

/** Human-readable status for a My Spaces row (matches the My Spaces STATUS column). */
export function formatMySpaceHandleStatusLabel(
  space: MySpaceStatusInput | null | undefined
): string {
  if (!space) return 'Unknown';

  if (space.status === 'certificate_pending') return 'Preparing Certificate';
  if (space.status === 'certificate_delivered') return 'Certificate Ready';

  if (space.chainPresence === 'on-chain') return 'On-chain';
  if (
    space.subsHandleStatus === 'committed' &&
    (space.subsCommitmentRootConfirming || space.subsPipelineBatchConfirming)
  ) {
    return 'Confirming';
  }
  if (space.subsHandleStatus === 'committed') return 'Committed';
  if (space.subsHandleStatus === 'staged') return 'Staged';
  if (space.chainPresence !== 'on-chain' && space.tenantQuotePaymentConfirmed === false) {
    return 'Awaiting Payment';
  }
  if (
    space.chainPresence !== 'on-chain' &&
    space.tenantQuotePaymentConfirmed === true &&
    space.subsHandleStatus !== 'committed'
  ) {
    return 'Staged';
  }

  const unifiedLabel = space.status ? UNIFIED_STATUS_LABELS[space.status] : undefined;
  if (unifiedLabel) return unifiedLabel;
  if (space.chainPresence !== 'on-chain') return 'Off-chain';

  return 'Unknown';
}
