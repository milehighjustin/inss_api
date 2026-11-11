import { Hono } from 'hono'

import { requireUser } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import {
  PushError,
  removeSubscription,
  saveSubscription,
  sendToBrowserSubscriptions,
  vapidPublicKey,
} from '../push/browser.ts'
import { sendByTags } from '../push/hub.ts'
import { platformsFor } from '../push/installations.ts'
import { LIMITS, checkLimit, retryAfterHeaders } from '../rateLimit.ts'

/**
 * Browser alerts: a browser registering to be told, and being told.
 *
 * The client is the web build on Windows, macOS or Linux. It asks for the key,
 * subscribes with it, and posts the subscription here; the server keeps that
 * subscription and sends to it directly on every alert. There is no device
 * token, nothing to rotate, and no hub installation to keep in step.
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
 *
 * This service is the only sender to browsers, so the pair behind this key lives
 * in its environment and nowhere else: the private half signs every browser
 * alert, and a subscription made with this key is reachable by nothing that does
 * not hold it.
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
 * devices, whichever they are: every browser subscribed to this account, and
 * their phones through the hub.
 *
 * This is how someone proves alerts work without waiting for a code to be
 * scanned. It is scoped to the caller by construction — every send uses only the
 * caller's `user:<id>` tag or their own subscriptions — so it cannot be used to
 * reach anyone else.
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

  // Only the platforms this one account has: a test should not depend on
  // credentials for a device the person does not own.
  const platforms = await platformsFor([user.userId])

  const [browsers, hub] = await Promise.all([
    sendToBrowserSubscriptions([user.userId], { ...message, url: '/' }),
    sendByTags([`user:${user.userId}`], { ...message, url: '/' }, { platforms }),
  ])

  // Browsers are counted, not guessed: one subscription answered each. The hub
  // reports a platform rather than a device count, so each platform it accepted
  // counts as one phone told — enough for a button that only has to answer "did
  // anything arrive".
  const browser = browsers.sent
  const phone = hub.legs.filter((leg) => leg.ok).length
  const sent = browser + phone

  if (sent === 0) {
    if (browsers.skipped === 'not-configured' && hub.skipped === 'not-configured') {
      return fail(c, 'Alerts are not configured on the server yet.', 500)
    }

    // Browsers first: their error is the one a desktop user can act on.
    const reason = browsers.errors[0] ?? hub.errors[0]
    return fail(
      c,
      reason
        ? `No device of yours accepted it: ${reason}`
        : 'No device of yours is registered for alerts. Turn them on first.',
      404,
    )
  }

  return c.json({ sent, browser, phone })
})
