export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

const RETRYABLE_SUBSTRINGS = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'overloaded',
  'overload',
  'capacity',
  'quota exceeded',
  'quota_exceeded',
  'temporarily unavailable',
  'internal server error',
  'server error',
  'timeout',
  'timed out',
  'connection reset',
  'econnreset',
  'network error',
  'fetch failed',
  'apierror',
  'api_error',
  'bad gateway',
  'gateway timeout',
];

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504, 529];

const NON_RETRYABLE_STATUSES = [400, 401, 403, 404];

export function isRetryableError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = extractStatus(err);

  if (status !== null) {
    if (NON_RETRYABLE_STATUSES.includes(status)) return false;
    if (RETRYABLE_STATUSES.includes(status)) return true;
  }

  return RETRYABLE_SUBSTRINGS.some((s) => message.includes(s));
}

function extractStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (e.error && typeof e.error === 'object') {
      const inner = e.error as Record<string, unknown>;
      if (typeof inner.status === 'number') return inner.status;
    }
  }
  return null;
}

function calculateBackoff(attempt: number, options: RetryOptions): number {
  const baseDelay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
  const delay = Math.min(baseDelay, options.maxDelayMs);
  if (options.jitter) {
    const jitterMs = delay * 0.25 * Math.random();
    return Math.floor(delay + jitterMs);
  }
  return delay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
  description?: string
): Promise<T> {
  const maxAttempts = options.maxRetries + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= options.maxRetries || !isRetryableError(err)) {
        throw err;
      }

      const backoffMs = calculateBackoff(attempt, options);
      const label = description ? ` ${description} —` : '';
      console.warn(
        `[Retry ${attempt + 1}/${options.maxRetries}]${label} retrying in ${backoffMs}ms: ${err instanceof Error ? err.message : String(err)}`
      );

      await sleep(backoffMs);
    }
  }

  throw lastError;
}
