/**
 * A small in-process rate limiter.
 *
 * It exists for the two endpoints that spend something when they are called:
 * sending a notification, and sending a test one. Both are cheap to abuse
 * accidentally — a double-tapped button, a script, a composer left on a loop —
 * and neither is worth a dependency or a shared store.
 *
 * **One process, one counter.** This is memory in the process that answers the
 * request, so it does not span instances and it resets on a restart. That fits
 * this service: the socket server already pins it to a single instance, because
 * a device attached to one process has to be visible to the console attached to
 * another. If it ever scales out, this moves to Redis with the adapter.
 *
 * Fixed windows, because the point is a ceiling, not smoothness: `limit` calls
 * per `windowMs`, then a refusal that says how long to wait.
 */

export interface Limit {
  /** How many calls the window allows. */
  limit: number
  /** How long the window is. */
  windowMs: number
}

export interface Refusal {
  ok: false
  retryAfterSeconds: number
}

export interface Allowed {
  ok: true
  remaining: number
}

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

/** Above this many tracked keys, expired windows are swept on the next call. */
const SWEEP_AT = 2000

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

/**
 * Counts one call against `key`.
 *
 * The key is what is being limited — an administrator's send, a person's test —
 * so two people never share a window.
 */
export function checkLimit(key: string, { limit, windowMs }: Limit, now = Date.now()): Allowed | Refusal {
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    if (buckets.size > SWEEP_AT) sweep(now)

    return { ok: true, remaining: Math.max(limit - 1, 0) }
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1),
    }
  }

  bucket.count += 1
  return { ok: true, remaining: Math.max(limit - bucket.count, 0) }
}

/** Drops every window. Used by tests and by a graceful shutdown. */
export function resetLimits(): void {
  buckets.clear()
}

/** The limits, in one place so they can be read together. */
export const LIMITS = {
  /** A manual send: thirty in ten minutes is already a lot of alerts. */
  send: { limit: 30, windowMs: 10 * 60_000 },
  /** A test alert, per person: enough to prove it, not enough to spam. */
  test: { limit: 5, windowMs: 5 * 60_000 },
} as const

/** The `Retry-After` header a 429 carries, in seconds. */
export function retryAfterHeaders(retryAfterSeconds: number): Record<string, string> {
  return { 'Retry-After': String(retryAfterSeconds) }
}
