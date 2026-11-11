import { createHash } from 'node:crypto'

import webpush from 'web-push'

import { db } from '../db.ts'

import { browserPayload, type BrowserAlert, type PushPriority } from './payload.ts'

/**
 * Alerts for a browser — which is what a Windows, macOS or Linux user runs.
 *
 * The apps on a phone are not the only clients: v2's web build is what an
 * operator opens on a desktop, and it has to be told when a code is scanned just
 * as a phone does. A browser subscribes once (`pushManager.subscribe`), which
 * yields an endpoint and two keys; those are stored here against the user who is
 * signed in, and every alert is then sent **straight from this service** to that
 * endpoint with `web-push`.
 *
 * Azure Notification Hubs is not in this path, on purpose. A hub routes by a tag
 * expression stored on each installation, which means every browser has to be
 * registered, re-registered when its tags change, and repaired when a write
 * fails — all of that to reach an endpoint we already know. A browser alert is
 * addressed to a list of people the scan already resolved, so it is one request
 * per subscription and nothing to keep in sync. The hub stays for what it is
 * genuinely better at: the APNs and FCM tokens of the native apps, which this
 * service has no way to deliver to itself.
 *
 * The cost of skipping the hub is that the sender has to hold the key the
 * browser subscribed with: `VAPID_PUBLIC_KEY` is handed to the page to subscribe
 * with, and `VAPID_PRIVATE_KEY` signs every send here. Because nothing else
 * sends to browsers, that pair lives in this service's environment only.
 *
 * This collection is also the record of which browsers an account has alerts on
 * — the account screen lists them, and removing one deletes its row.
 */

export type { PushPriority }

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

export type PushMessage = BrowserAlert

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
 * Both halves come from the environment: the public one is what the app
 * subscribes with, the private one signs every send. A new pair invalidates
 * every existing subscription in the field — the browser accepts a push only
 * from the key its subscription was made under — so it is generated once and
 * kept.
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

/**
 * Forgets every browser this account had alerts on.
 *
 * Called when an account is deactivated: a deactivated person must stop getting
 * alerts whether or not their browser is still signed in. Reactivating does not
 * recreate them — each browser re-registers the next time the app is opened.
 */
export async function deleteBrowserSubscriptions(userId: string): Promise<number> {
  const collection = await subscriptions()
  const result = await collection.deleteMany({ userId })

  return result.deletedCount
}

/**
 * Forgets browsers nobody has opened in a long time.
 *
 * Nothing has to be repaired any more — a subscription is used exactly as it was
 * stored — so this job only has to stop the collection growing: a browser that
 * has not re-registered in three months is one the app no longer runs in, and its
 * endpoint is dead weight. Sends also delete rows the push service reports as
 * gone (404/410), so this catches what those never see.
 */
export async function pruneBrowserSubscriptions(days = 90): Promise<{ pruned: number }> {
  const collection = await subscriptions()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const pruned = await collection.deleteMany({ updatedAt: { $lt: cutoff } })

  return { pruned: pruned.deletedCount }
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

/** How many browsers these accounts have alerts on. For the composer's estimate. */
export async function countBrowserSubscriptions(userIds: string[]): Promise<number> {
  const recipients = [...new Set(userIds.filter(Boolean))]
  if (recipients.length === 0) return 0

  const collection = await subscriptions()
  return collection.countDocuments({ userId: { $in: recipients } })
}

/**
 * Tells every browser these people have alerts turned on.
 *
 * One request per subscription, in parallel, each bounded by a timeout: a scan is
 * waiting on this and a slow push service must not hold a redirect. The audience
 * is already resolved — it is the same list the in-app ring used — so there is no
 * tag expression and nobody has to be excluded afterwards. A 404 or 410 means the
 * browser is gone — permission revoked, profile deleted, endpoint expired — so
 * the row is deleted rather than kept and retried forever.
 */
export async function sendToBrowserSubscriptions(
  userIds: string[],
  message: PushMessage,
): Promise<PushResult> {
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

  const payload = JSON.stringify(browserPayload(message))
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
