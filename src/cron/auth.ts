import { timingSafeEqual } from 'node:crypto'

import type { Context } from 'hono'

/**
 * The handshake an external scheduler uses.
 *
 * These endpoints refill the collections every screen reads, so they cannot be
 * open to the internet. `CRON_SECRET` is the shared secret v1's Vercel crons
 * used, presented as `Authorization: Bearer <secret>` — the same header, so a
 * scheduler copied across from v1 keeps working.
 *
 * With no secret configured nothing is authorized: v1 compared against
 * `Bearer undefined`, which meant the literal string worked when the variable
 * was missing. Refusing is the only safe reading of an unset secret.
 */
export function cronAuthorized(c: Context): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false

  const header = c.req.header('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!presented) return false

  const sent = Buffer.from(presented)
  const wanted = Buffer.from(expected)
  // timingSafeEqual refuses buffers of different lengths, so match on length
  // first; the secret's length is not the secret.
  if (sent.length !== wanted.length) return false

  return timingSafeEqual(sent, wanted)
}
