import { Hono } from 'hono'

import { requireUser } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import {
  PushError,
  removeSubscription,
  saveSubscription,
  sendToUsers,
  vapidPublicKey,
} from '../push/browser.ts'
import { sendByTags } from '../push/hub.ts'
import { LIMITS, checkLimit, retryAfterHeaders } from '../rateLimit.ts'

/**
 * Desktop alerts: a browser registering to be told, and being told.
 *
 * The client is the web build on Windows, macOS or Linux. It asks for the key,
 * subscribes with it, and posts the subscription here; the server keeps it
 * against the signed-in user and sends to it when a code is scanned. There is no
 * device token and nothing to rotate.
 *
 * Nothing here is administrator-only: every route acts on the caller's own
 * subscriptions, and a user can only stop their own alerts.
 */

export const pushRoutes = new Hono()

/** The three fields a browser subscription carries, or null when incomplete. */
function keysOf(value: unknown): { p256dh: string; auth: string } | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Record<string, unknown>
  const p256dh = text(raw.p256dh)
  const auth = text(raw.auth)

  return p256dh && auth ? { p256dh, auth } : null
}

/**
 * GET /api/mobile/push/key
 *
 * Success: { publicKey } — the VAPID public key to subscribe with, or null when
 * the server has no keys yet. The app says so rather than failing at subscribe
 * time with an error nobody can act on.
 */
pushRoutes.get('/key', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  return c.json({ publicKey: vapidPublicKey() })
})

/**
 * POST /api/mobile/push/subscribe   { endpoint, keys: { p256dh, auth }, device? }
 *
 * Success: { subscription: { endpoint, device, createdAt, updatedAt } }
 *
 * Called from the button that turns alerts on, and again whenever the app starts
 * with a subscription already in the browser — so the alerts belong to whoever is
 * signed in now, and a browser shared between two people does not keep telling
 * the first one.
 */
pushRoutes.post('/subscribe', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  const keys = keysOf(body.keys)
  if (!keys) return fail(c, 'A push subscription needs both of its keys', 400)

  try {
    const subscription = await saveSubscription(user.userId, {
      endpoint: text(body.endpoint),
      keys,
      device: text(body.device),
    })

    return c.json({ subscription })
  } catch (cause) {
    if (cause instanceof PushError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/**
 * POST /api/mobile/push/unsubscribe   { endpoint }
 *
 * Success: { deleted } — false when there was nothing left to remove, which is
 * the outcome the caller wanted anyway.
 */
pushRoutes.post('/unsubscribe', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const deleted = await removeSubscription(user.userId, text(body.endpoint))
    return c.json({ deleted })
  } catch (cause) {
    if (cause instanceof PushError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/**
 * POST /api/mobile/push/test
 *
 * Success: { sent, browser, phone } — one loud alert to the caller's own
 * devices, whichever they are: browsers this account has subscribed, and phones
 * it has registered with the hub.
 *
 * This is how someone proves alerts work without waiting for a code to be
 * scanned. It is scoped to the caller by construction — the browser lookup is by
 * account, and the phone send uses only the caller's `user:<id>` tag — so it
 * cannot be used to reach anyone else.
 */
pushRoutes.post('/test', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  // Five in five minutes proves it works; more than that is a button being held
  // down, and every one of them is a loud alert on the person's own devices.
  const allowed = checkLimit(`test:${user.userId}`, LIMITS.test)
  if (!allowed.ok) {
    return fail(
      c,
      `Give it a moment before sending another test — try again in ${allowed.retryAfterSeconds} seconds.`,
      429,
      retryAfterHeaders(allowed.retryAfterSeconds),
    )
  }

  const message = {
    title: 'Alerts are on',
    body: 'This is a test from the INSS app. A scan of a code you watch will arrive like this.',
    priority: 'loud' as const,
    tag: 'inss-test',
    data: { kind: 'test' },
  }

  const [browser, phone] = await Promise.all([
    sendToUsers([user.userId], { ...message, url: '/' }),
    sendByTags([`user:${user.userId}`], message),
  ])

  const sent = browser.sent + phone.sent

  if (sent === 0) {
    if (browser.skipped === 'not-configured' && phone.skipped === 'not-configured') {
      return fail(c, 'Alerts are not configured on the server yet.', 500)
    }

    return fail(c, 'No device of yours is registered for alerts. Turn them on first.', 404)
  }

  return c.json({ sent, browser: browser.sent, phone: phone.sent })
})
