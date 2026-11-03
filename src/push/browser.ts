import { createHash } from 'node:crypto'

import webpush from 'web-push'

import { db } from '../db.ts'

/**
 * Alerts for a browser — which is what a Windows, macOS or Linux user runs.
 *
 * The apps on a phone are not the only clients: v2's web build is what an
 * operator opens on a desktop, and it has to be told when a code is scanned just
 * as a phone does. A browser receives push through the Web Push protocol, so
 * this module is the desktop half of delivery:
 *
 * - A browser subscribes once (`pushManager.subscribe`), which yields an
 *   endpoint and two keys. That is stored here against the user who is signed in.
 * - A send encrypts one payload per subscription and posts it to that endpoint;
 *   the browser's push service wakes the service worker, which shows the
 *   notification. The browser does not have to be open.
 *
 * Why not Azure Notification Hubs for this? Its browser platform is web push, but
 * it excludes Safari, and Safari on macOS is a browser investors will use. The
 * standard protocol covers Chrome and Edge on Windows, and Chrome, Firefox and
 * Safari 16+ on macOS and Linux, so every desktop is one code path here.
 *
 * Tags are not involved yet: a send names the accounts to tell and this looks up
 * their subscriptions. When the tag registry lands, `sendToTags` filters this
 * same collection by the tags on the user — nothing about the transport changes.
 */

export type PushPriority = 'loud' | 'quiet'

/**
 * The mark a desktop alert wears, as a path on the app's own origin.
 *
 * A notification shown by a browser is otherwise attributed to the browser —
 * "Google Chrome · app.inselfstorage.com" with Chrome's icon, which reads as a
 * message from the browser rather than from INSS. These two files live in the
 * app's `public/`, so the export copies them to the site root and the service
 * worker resolves the paths against its own origin. Relative on purpose: this
 * service does not know, and should not have to know, where the app is hosted.
 */
const NOTIFICATION_ICON = '/notification-icon.png'
/** The monochrome silhouette some platforms draw in the status bar. */
const NOTIFICATION_BADGE = '/notification-badge.png'

/** The two keys a browser subscription carries. Never logged, never returned. */
export interface PushSubscriptionKeys {
  p256dh: string
  auth: string
}

export interface PushSubscriptionRecord {
  _id: string
  userId: string
  endpoint: string
  keys: PushSubscriptionKeys
  /** What the browser says it is, for the account screen's list later. */
  device: string
  createdAt: Date
  updatedAt: Date
  lastSentAt?: Date
  lastError?: string
  failedAt?: Date
}

/** What the app is told about its own subscription — no keys leave the server. */
export interface PushSubscriptionSummary {
  endpoint: string
  device: string
  createdAt: string
  updatedAt: string
}

export interface PushMessage {
  title: string
  body: string
  priority: PushPriority
  /**
   * Collapse key. A second alert with the same tag replaces the first in the
   * tray instead of stacking, which is what a code scanned twice should do.
   */
  tag?: string
  /** Where a click on the notification goes. */
  url?: string
  /** Copies of these strings ride along, for the service worker to use. */
  data?: Record<string, string>
}

export interface PushResult {
  /** Subscriptions the push service accepted. */
  sent: number
  /** Subscriptions the push service said are gone, now forgotten. */
  removed: number
  /** Why individual sends failed, deduped. */
  errors: string[]
  /** Set when VAPID keys are missing: nothing was even attempted. */
  skipped: 'not-configured' | null
}

function subscriptions() {
  return db('global').then((global) =>
    global.collection<PushSubscriptionRecord>('pushSubscriptions'),
  )
}

/**
 * The keys this service signs with.
 *
 * Both halves come from the environment: the public one is also what the app
 * subscribes with, so the two must match or the push service rejects every send.
 * Generate a pair once and keep it — a new pair invalidates every existing
 * subscription in the field.
 */
export function vapidKeys(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? ''
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? ''
  if (!publicKey || !privateKey) return null

  const subject =
    process.env.VAPID_SUBJECT?.trim() || 'mailto:support@inselfstorage.com'

  return { publicKey, privateKey, subject }
}

/** The public half, for the browser to subscribe with. Null when unconfigured. */
export function vapidPublicKey(): string | null {
  return vapidKeys()?.publicKey ?? null
}

let configured: string | null = null

/**
 * Hands the keys to web-push once. Returns whether sending is possible.
 *
 * A malformed key is a configuration error, not a per-send one, so it is logged
 * once and then treated as "not configured" — a scan still redirects and its log
 * row explains why nobody was told.
 */
function configure(): boolean {
  if (configured === 'yes') return true

  const keys = vapidKeys()
  if (!keys) return false

  try {
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey)
    configured = 'yes'
    return true
  } catch (cause) {
    if (configured !== 'broken') {
      console.error('[push] VAPID keys are not usable:', cause)
      configured = 'broken'
    }
    return false
  }
}

export class PushError extends Error {
  status: 400 | 404

  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.name = 'PushError'
    this.status = status
  }
}

/**
 * A subscription is keyed by its endpoint, hashed: the same browser subscribing
 * again updates one row rather than adding a second, and nothing identifies the
 * device by an address we can guess.
 */
function subscriptionId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

function checkEndpoint(value: string): string {
  if (!value) throw new PushError('A push subscription needs an endpoint')

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new PushError('That push endpoint is not a URL')
  }

  if (parsed.protocol !== 'https:') throw new PushError('A push endpoint must be https')
  if (value.length > 2048) throw new PushError('That push endpoint is too long')

  return value
}

/**
 * Records this browser as a way to reach this user.
 *
 * Idempotent on purpose: the app posts on every enable and on every launch where
 * the browser already has a subscription, so signing in as someone else on the
 * same browser moves the alerts to the person who is now signed in.
 */
export async function saveSubscription(
  userId: string,
  input: { endpoint: string; keys: PushSubscriptionKeys; device?: string },
): Promise<PushSubscriptionSummary> {
  const endpoint = checkEndpoint(input.endpoint.trim())
  const p256dh = input.keys.p256dh.trim()
  const auth = input.keys.auth.trim()

  if (!p256dh || !auth) throw new PushError('A push subscription needs both of its keys')
  if (p256dh.length > 200 || auth.length > 100) throw new PushError('Those push keys are not valid')

  const collection = await subscriptions()
  const now = new Date()
  const device = (input.device ?? '').slice(0, 200)

  await collection.updateOne(
    { _id: subscriptionId(endpoint) },
    {
      $set: { userId, endpoint, keys: { p256dh, auth }, device, updatedAt: now },
      $setOnInsert: { createdAt: now },
      // A fresh subscription is a fresh chance: whatever failed before is not
      // held against it.
      $unset: { lastError: '', failedAt: '' },
    },
    { upsert: true },
  )

  const row = await collection.findOne({ _id: subscriptionId(endpoint) })
  if (!row) throw new PushError('That subscription could not be saved')

  return {
    endpoint: row.endpoint,
    device: row.device,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Stops alerts to one browser.
 *
 * Scoped to the caller's own subscriptions, so a stray endpoint cannot mute
 * someone else's device. Answers whether there was anything to remove, which is
 * not an error either way: a browser that has already unsubscribed is the state
 * the caller wanted.
 */
export async function removeSubscription(userId: string, endpoint: string): Promise<boolean> {
  const clean = endpoint.trim()
  if (!clean) throw new PushError('Which subscription should be removed?')

  const collection = await subscriptions()
  const result = await collection.deleteOne({ _id: subscriptionId(clean), userId })
  return result.deletedCount > 0
}

/** Every browser this user has turned alerts on in. */
export async function userSubscriptions(userId: string): Promise<PushSubscriptionSummary[]> {
  const collection = await subscriptions()
  const rows = await collection.find({ userId }).sort({ updatedAt: -1 }).toArray()

  return rows.map((row) => ({
    endpoint: row.endpoint,
    device: row.device,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }))
}

/** The payload a service worker's `push` handler reads. */
function payloadFor(message: PushMessage): string {
  const quiet = message.priority === 'quiet'
  const tag = message.tag ?? 'inss'

  return JSON.stringify({
    title: message.title,
    body: message.body,
    // The worker turns this into `silent` and `requireInteraction`: quiet is a
    // notification that is there when you look, loud is one that says so.
    priority: quiet ? 'quiet' : 'loud',
    silent: quiet,
    tag,
    // A tag is what makes a replacement possible; without `renotify` a replaced
    // notification arrives without making a sound.
    renotify: !quiet,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    url: message.url ?? '/',
    timestamp: Date.now(),
    ...(message.data ?? {}),
  })
}

/**
 * Tells every browser belonging to these accounts.
 *
 * One request per subscription, in parallel, each bounded by a timeout: a scan
 * is waiting on this and a slow push service must not hold a redirect. A 404 or
 * 410 means the browser is gone — the subscription is deleted rather than kept
 * and retried forever.
 */
export async function sendToUsers(userIds: string[], message: PushMessage): Promise<PushResult> {
  const result: PushResult = { sent: 0, removed: 0, errors: [], skipped: null }

  const recipients = [...new Set(userIds.filter((id) => Boolean(id)))]
  if (recipients.length === 0) return result

  if (!configure()) {
    result.skipped = 'not-configured'
    return result
  }

  const collection = await subscriptions()
  const rows = await collection.find({ userId: { $in: recipients } }).toArray()
  if (rows.length === 0) return result

  const payload = payloadFor(message)
  const now = new Date()

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: row.keys },
          payload,
          {
            // Half a day: an alert nobody saw this afternoon is still worth
            // showing tonight, and after that it is history.
            TTL: 60 * 60 * 12,
            urgency: message.priority === 'loud' ? 'high' : 'low',
            timeout: 8000,
          },
        )

        result.sent += 1
        await collection.updateOne(
          { _id: row._id },
          { $set: { lastSentAt: now }, $unset: { lastError: '', failedAt: '' } },
        )
      } catch (cause) {
        const status = (cause as { statusCode?: number }).statusCode

        // The browser uninstalled, or revoked permission: forget it, quietly.
        if (status === 404 || status === 410) {
          await collection.deleteOne({ _id: row._id })
          result.removed += 1
          return
        }

        const error = cause instanceof Error ? cause.message : String(cause)
        if (!result.errors.includes(error)) result.errors.push(error)

        await collection.updateOne(
          { _id: row._id },
          { $set: { lastError: error, failedAt: now } },
        )
      }
    }),
  )

  return result
}
