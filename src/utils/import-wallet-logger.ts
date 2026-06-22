const PREFIX = '[ImportWallet]';

function formatDetail(detail: unknown): string {
  if (detail === undefined) {
    return '';
  }
  if (detail instanceof Error) {
    return detail.message;
  }
  if (typeof detail === 'string') {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function logImportStep(step: string, detail?: unknown): void {
  const suffix = detail === undefined ? '' : ` — ${formatDetail(detail)}`;
  console.log(`${PREFIX} ${step}${suffix}`);
}

export function logImportError(step: string, error: unknown): void {
  console.error(`${PREFIX} FAILED at ${step}:`, error);
}
