export type SpacePipelineSteps = {
  broadcast?: string;
  confirmed?: string;
  finalized?: string;
};

export type SpacePipelineSnapshot = {
  /** `null` when the pipeline request failed — do not overwrite stored confirming state. */
  batchConfirming: boolean | null;
  /** Hours until finalized when confirmed is complete and finalized is in progress. */
  finalizedHoursRemaining: number | null;
};

type SubsHandleSnapshot = {
  subsStatus: string | null;
  publishStatus?: string | null;
};

/** Batch is awaiting confirmation when broadcast finished and confirmation is in progress. */
export function isPipelineBatchConfirming(steps: SpacePipelineSteps | null | undefined): boolean {
  return steps?.broadcast === 'complete' && steps?.confirmed === 'in_progress';
}

/** Space batch is awaiting finalization after confirmations completed. */
export function isPipelineFinalizing(steps: SpacePipelineSteps | null | undefined): boolean {
  return steps?.confirmed === 'complete' && steps?.finalized === 'in_progress';
}

/** Parse `"x/150 confirmations"` → hours remaining: `(150 - x) / 6`. */
export function parseFinalizedHoursFromConfirmationsMessage(message: unknown): number | null {
  if (typeof message !== 'string') {
    return null;
  }
  const match = message.trim().match(/^(\d+)\/150 confirmations$/i);
  if (!match) {
    return null;
  }
  const x = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(x) || x < 0 || x > 150) {
    return null;
  }
  return Math.round(((150 - x) / 6) * 10) / 10;
}

/**
 * GET /spaces/@{space}/pipeline — space-level batch pipeline (not per-handle).
 */
export async function fetchSpacePipelineSnapshot(
  baseUrl: string,
  spaceName: string
): Promise<SpacePipelineSnapshot | null> {
  const b = baseUrl.replace(/\/$/, '');
  const spaceSlug = `@${spaceName.toLowerCase()}`;
  const url = `${b}/spaces/${encodeURIComponent(spaceSlug)}/pipeline`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const steps =
      o.steps && typeof o.steps === 'object' ? (o.steps as SpacePipelineSteps) : null;
    if (!res.ok || o.success === false) {
      console.warn('[Spaces] space pipeline', { url, status: res.status, body });
      return null;
    }
    if (
      !steps &&
      (typeof o.handle === 'string' || o.price != null || typeof o.state === 'string')
    ) {
      console.warn('[Spaces] space pipeline: unexpected handle payload', { url, body: o });
      return null;
    }
    if (!steps) {
      console.warn('[Spaces] space pipeline: missing steps', { url, body: o });
      return null;
    }

    const batchConfirming = isPipelineBatchConfirming(steps);
    const finalizedHoursRemaining = isPipelineFinalizing(steps)
      ? parseFinalizedHoursFromConfirmationsMessage(o.message)
      : null;

    console.log('[Spaces] space pipeline', {
      url,
      batchConfirming,
      finalizedHoursRemaining,
      steps,
      message: o.message,
    });

    return { batchConfirming, finalizedHoursRemaining };
  } catch (e) {
    console.warn('[Spaces] space pipeline', url, e);
    return null;
  }
}

/**
 * Prefer space pipeline steps; when unavailable, infer from subs `publish_status`
 * (`null` ⇒ batch confirmation still in progress, `final` ⇒ settled).
 */
export function resolveSubsBatchConfirming(
  subs: SubsHandleSnapshot | null | undefined,
  pipelineConfirming: boolean | null
): boolean | null {
  if (subs?.subsStatus !== 'committed') {
    return false;
  }
  if (pipelineConfirming !== null) {
    return pipelineConfirming;
  }
  if (subs.publishStatus === 'final') {
    return false;
  }
  if (subs.publishStatus == null) {
    return true;
  }
  return null;
}

export function subsPipelineFieldsFromUpdate(
  subs: SubsHandleSnapshot | null | undefined,
  pipelineConfirming: boolean | null
): { subsPipelineBatchConfirming?: boolean } {
  const resolved = resolveSubsBatchConfirming(subs, pipelineConfirming);
  if (subs?.subsStatus !== 'committed') {
    return { subsPipelineBatchConfirming: false };
  }
  if (resolved === null) {
    return {};
  }
  return { subsPipelineBatchConfirming: resolved };
}

export function pipelineSnapshotFieldsFromUpdate(
  subs: SubsHandleSnapshot | null | undefined,
  snapshot: SpacePipelineSnapshot | null | undefined
): {
  subsPipelineBatchConfirming?: boolean;
  pipelineFinalizedHoursRemaining?: number | null;
} {
  if (subs?.subsStatus !== 'committed') {
    return {
      subsPipelineBatchConfirming: false,
      pipelineFinalizedHoursRemaining: null,
    };
  }
  if (!snapshot) {
    return subsPipelineFieldsFromUpdate(subs, null);
  }
  return {
    ...subsPipelineFieldsFromUpdate(subs, snapshot.batchConfirming),
    pipelineFinalizedHoursRemaining: snapshot.finalizedHoursRemaining,
  };
}

/** My Spaces third column: finalized ETA or poll countdown. */
export function formatMySpacesThirdColumnLabel(
  space: { pipelineFinalizedHoursRemaining?: number | null },
  timeUntilNextCheckMinutes: number | null
): string {
  if (space.pipelineFinalizedHoursRemaining != null) {
    return `~ ${space.pipelineFinalizedHoursRemaining} hrs`;
  }
  if (timeUntilNextCheckMinutes !== null) {
    return `${timeUntilNextCheckMinutes} min`;
  }
  return '-';
}
