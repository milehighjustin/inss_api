import { randomUUID } from 'node:crypto'

import { db } from './db.ts'
import { usersWithTags } from './notificationTags.ts'
import { sendToBrowserSubscriptions } from './push/browser.ts'
import { platformsFor } from './push/installations.ts'
import { sendByTags, tagExpressionFor, userTags } from './push/hub.ts'
import type { QrCode, QrNotificationPriority } from './qr.ts'
import { qrNames } from './qr.ts'
import { recordOffers, type AlertRef } from './activity.ts'
import { ringUsers } from './rtcSignaling.ts'
import { onDuty } from './support.ts'

/**
 * The notifications a scan produces, and the one place they leave the system.
 *
 * An alert is addressed to **tags**, and the tags become people here: the
 * accounts carrying one are looked up, and every channel they have enabled is
 * then told — phones through Notification Hubs by tag expression, browsers by
 * this service sending to each subscription it holds. Codes configured before
 * tags keep their named recipients, and those ids ride along as `user:<id>` tags
 * so a printed sign does not have to be reprinted.
 *
 * The record is the contract and the history. Whatever happens — nothing
 * configured, nobody subscribed, a push service refusing — is written back onto
 * the row, so an empty notification tray is explained rather than mysterious.
 */

export type NotificationStatus = 'pending' | 'delivered' | 'failed' | 'suppressed'

export type NotificationKind = 'qr-scan' | 'manual' | 'document'

export type NotificationChannel = 'browser' | 'apns' | 'fcmv1' | 'wns'

/** One attempt, per transport, and how it went. */
export interface NotificationSend {
  channel: NotificationChannel
  ok: boolean
  error?: string
}

export interface NotificationRecord {
  _id: string
  kind: NotificationKind
  qrCodeId?: string
  qrCodeName?: string
  /** The document that was posted, when this alert announces one. */
  documentId?: string
  documentName?: string
  documentFolder?: string
  /** Where the scan was sent, for context in the message. */
  destination?: string
  /** The property the code stands at, when one is chosen. */
  locationId?: string
  locationName?: string
  /** The video kiosk beside that sign, if there is one. */
  rtcDeviceId?: string
  rtcDeviceName?: string
  title: string
  body: string
  /** `loud` means it should interrupt; `quiet` means it should not make a sound. */
  priority: QrNotificationPriority
  /** The notification tag slugs this was addressed to. */
  tags: string[]
  /** Named accounts, kept for codes set up before tags existed. */
  recipients: string[]
  /** The tag expression the hub was sent, when there was one. */
  expression?: string
  sends: NotificationSend[]
  createdBy?: string
  createdAt: Date
  status: NotificationStatus
  /** When at least one device accepted the message. */
  deliveredAt?: Date
  /** What happened, in a sentence — the reason a tray is empty when it is. */
  note?: string
}

function notifications() {
  return db('global').then((global) => global.collection<NotificationRecord>('notifications'))
}

/** Old rows have no `tags`, `sends` or `status`; fill them in on the way out. */
function complete(row: NotificationRecord): NotificationRecord {
  return {
    ...row,
    tags: row.tags ?? [],
    recipients: row.recipients ?? [],
    sends: row.sends ?? [],
    status: row.status ?? 'pending',
  }
}

/**
 * How long a code stays quiet after an alert.
 *
 * A link preview fetches the URL, a double tap scans twice, and a person who
 * scans a broken code tries again — none of those should ring someone's phone a
 * second time. The window is per code, not per person, and it is configuration
 * (`NOTIFY_DEBOUNCE_SECONDS`) rather than a constant, because the right number
 * depends on how chatty a site's codes are. Zero turns it off.
 */
function debounceSeconds(): number {
  const raw = Number(process.env.NOTIFY_DEBOUNCE_SECONDS ?? '60')
  return Number.isFinite(raw) && raw >= 0 ? raw : 60
}

/**
 * Records a scan of a code that asks to be noticed, and asks for delivery.
 *
 * Returns null when the code does not notify anyone — most codes do not, and a
 * scan of one is just a redirect.
 */
export async function notifyQrScan(code: QrCode, when = new Date()): Promise<NotificationRecord | null> {
  if (!code.notification.title) return null
  if (code.notifyTags.length === 0 && code.notifyUserIds.length === 0) return null

  // The names behind the ids, resolved once here: an alert that says "Maple
  // Street" ages better than one that says "some property", and the person
  // answering it needs to recognise the place without looking anything up.
  const names = await qrNames(code)

  const record: NotificationRecord = {
    _id: randomUUID(),
    kind: 'qr-scan',
    qrCodeId: code.id,
    qrCodeName: code.name,
    destination: code.url,
    ...(code.locationId
      ? { locationId: code.locationId, locationName: names.locationName || code.locationId }
      : {}),
    ...(code.rtcDeviceId
      ? { rtcDeviceId: code.rtcDeviceId, rtcDeviceName: names.rtcDeviceName || code.rtcDeviceId }
      : {}),
    title: code.notification.title,
    body: code.notification.body,
    priority: code.notification.priority,
    tags: [...code.notifyTags],
    recipients: [...code.notifyUserIds],
    sends: [],
    createdAt: when,
    status: 'pending',
  }

  const collection = await notifications()
  const window = debounceSeconds()

  // The quiet window: a scan that lands inside it is recorded — every scan is
  // still a scan — but it is not sent again.
  if (window > 0) {
    const previous = await collection
      .find({
        qrCodeId: code.id,
        status: { $in: ['delivered', 'pending'] },
        createdAt: { $gte: new Date(when.getTime() - window * 1000) },
      })
      .sort({ createdAt: -1 })
      .limit(1)
      .next()

    if (previous) {
      const seconds = Math.max(
        1,
        Math.round((when.getTime() - previous.createdAt.getTime()) / 1000),
      )

      const suppressed: NotificationRecord = {
        ...record,
        status: 'suppressed',
        note: `Another scan of “${code.name}” was sent ${seconds}s ago, inside the ${window}s quiet window — this one was recorded, not sent.`,
      }

      await collection.insertOne(suppressed)
      return suppressed
    }
  }

  await collection.insertOne(record)
  await deliver(record)

  return record
}

/**
 * Tells the investors who can see a file that it has been posted.
 *
 * This is the one notification addressed to **people**, not to tags: the
 * audience is the document's own — every investor, one investor, or the
 * investors holding the property — worked out by `documentAudienceUserIds`. There
 * is deliberately no quiet window here: two statements uploaded a minute apart
 * are two things to look at, not a double tap on a sign.
 */
export async function notifyDocumentUpload(input: {
  documentId: string
  documentName: string
  folder: string
  recipients: string[]
  title: string
  body: string
  priority: QrNotificationPriority
  createdBy?: string
}): Promise<NotificationRecord> {
  const record: NotificationRecord = {
    _id: randomUUID(),
    kind: 'document',
    documentId: input.documentId,
    documentName: input.documentName,
    documentFolder: input.folder,
    title: input.title,
    body: input.body,
    priority: input.priority,
    tags: [],
    recipients: [...new Set(input.recipients)],
    sends: [],
    createdBy: input.createdBy,
    createdAt: new Date(),
    status: 'pending',
  }

  const collection = await notifications()
  await collection.insertOne(record)
  await deliver(record)

  // Read back what delivery wrote, so the uploader is told whether the alert
  // actually reached a device instead of a hopeful "pending".
  const row = await collection.findOne({ _id: record._id })
  return row ? complete(row) : record
}

/** An alert sent by hand from the admin console, rather than by a scan. */
export async function sendManual(input: {
  tags: string[]
  title: string
  body: string
  priority: QrNotificationPriority
  createdBy?: string
}): Promise<NotificationRecord> {
  const record: NotificationRecord = {
    _id: randomUUID(),
    kind: 'manual',
    title: input.title,
    body: input.body,
    priority: input.priority,
    tags: [...input.tags],
    recipients: [],
    sends: [],
    createdBy: input.createdBy,
    createdAt: new Date(),
    status: 'pending',
  }

  await (await notifications()).insertOne(record)
  await deliver(record)

  return record
}

/**
 * The recent log, newest first.
 *
 * Rows written before tags existed have no `tags` or `sends`, so they are filled
 * in here rather than leaving the console to guess: an old scan is still a
 * record of something that happened, just a blank one.
 */
export async function recentNotifications(limit = 50): Promise<NotificationRecord[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await (await notifications()).find({}).sort({ createdAt: -1 }).limit(capped).toArray()

  return rows.map(complete)
}

/**
 * The alerts one code raised, newest first.
 *
 * This is what the QR panel shows under "Recent alerts": whether the code is
 * actually being scanned, what was sent, and whether anything arrived. A row that
 * was suppressed inside the quiet window is evidence of scans without being an
 * alert.
 */
export async function notificationsForCode(
  qrCodeId: string,
  limit = 10,
): Promise<NotificationRecord[]> {
  const capped = Math.min(Math.max(limit, 1), 50)

  const rows = await (await notifications())
    .find({ qrCodeId })
    .sort({ createdAt: -1 })
    .limit(capped)
    .toArray()

  return rows.map(complete)
}

/**
 * Delivery.
 *
 * One message, sent down two paths, neither able to fail the other:
 *
 * - **Browsers** — the desktop and web client — are pushed directly by
 *   `push/browser.ts`, one encrypted request per subscription, to the audience
 *   resolved above. No hub, no tag expression.
 * - **The hub**: an APNs send, an FCM v1 send and a WNS send by tag expression
 *   — but only for the platforms the audience actually has, so Azure fans out to
 *   the iPhones, Macs and Android phones carrying those tags.
 *
 * Browser alerts are deliberately held back from anyone on a call, because the
 * browser send runs from this resolved list: somebody who is held is simply not
 * in it. For the phones the same exclusion has to travel inside the expression
 * as `&& !(user:…)`, since Azure does that fan-out.
 *
 * A failure never fails the scan: the row keeps what happened, and a scan's
 * redirect is answered whatever the push services say.
 */
async function deliver(record: NotificationRecord): Promise<void> {
  const addressed = [
    ...new Set([...(await usersWithTags(record.tags)), ...record.recipients]),
  ]

  // A support account hears what its tags address only while its shift is open.
  // This is resolved here, before anything is offered or rung, so an off-duty
  // person is never counted as having missed an alert they were not sent.
  const duty = await onDuty(addressed)
  const audience = duty.onDuty

  const alert = {
    id: record._id,
    title: record.title,
    body: record.body,
    priority: record.priority,
    ...(record.qrCodeId ? { qrCodeId: record.qrCodeId } : {}),
    ...(record.qrCodeName ? { qrCodeName: record.qrCodeName } : {}),
    ...(record.destination ? { destination: record.destination } : {}),
    ...(record.locationId ? { locationId: record.locationId } : {}),
    ...(record.locationName ? { locationName: record.locationName } : {}),
    ...(record.rtcDeviceId ? { rtcDeviceId: record.rtcDeviceId } : {}),
    ...(record.rtcDeviceName ? { rtcDeviceName: record.rtcDeviceName } : {}),
    createdAt: record.createdAt.toISOString(),
  }

  // A loud alert rings first, before any push call: the people it is for may
  // have the app open, and a window that rings in a second is not a call. This
  // is the transport that does not need permission — push is what is left when
  // nobody is looking at the app.
  //
  // Somebody already on a call is not rung. Their alert is held and rings when
  // the call ends, and they are left out of the push as well, so a conversation
  // is not interrupted by a banner about a different sign.
  // A posted document is not a call: it neither rings the in-app takeover nor
  // counts as an offer in the operator performance figures. It is still pushed,
  // loud or quiet, on every channel the person has turned on.
  const rings = record.kind !== 'document'

  let reachable = audience
  // Whoever is answered on a call right now. The hub fans out by tag, so these
  // have to travel as an exclusion in the expression rather than be filtered out
  // of a list after the fact.
  let held: string[] = []
  if (rings && record.priority === 'loud') {
    const rung = ringUsers(audience, alert)
    reachable = rung.reached
    held = rung.held

    const ref: AlertRef = {
      notificationId: record._id,
      ...(record.qrCodeId ? { qrCodeId: record.qrCodeId } : {}),
      ...(record.qrCodeName ? { qrCodeName: record.qrCodeName } : {}),
      ...(record.locationId ? { locationId: record.locationId } : {}),
      ...(record.locationName ? { locationName: record.locationName } : {}),
      ...(record.rtcDeviceId ? { rtcDeviceId: record.rtcDeviceId } : {}),
      ...(record.rtcDeviceName ? { rtcDeviceName: record.rtcDeviceName } : {}),
    }

    await recordOffers(ref, rung.reached, false)
    await recordOffers(ref, rung.held, true)
  } else if (rings) {
    // Quiet alerts produce no call, but they are still offers to the people they
    // reach: a supervisor reading "answered ÷ offered" should not have the quiet
    // codes disappear from the denominator.
    await recordOffers(
      {
        notificationId: record._id,
        ...(record.qrCodeId ? { qrCodeId: record.qrCodeId } : {}),
        ...(record.qrCodeName ? { qrCodeName: record.qrCodeName } : {}),
        ...(record.locationId ? { locationId: record.locationId } : {}),
        ...(record.locationName ? { locationName: record.locationName } : {}),
      },
      audience,
      false,
    )
  }

  const ntTags = record.tags.map((tag) => `nt:${tag}`)
  const named = userTags(record.recipients)
  // Twenty is the push service's ceiling for one OR expression. Authoring
  // refuses to go past it; a code from before that rule is cut here rather than
  // failing the whole send, and its named people are still reached directly.
  const hubTags = [...ntTags, ...named].slice(0, 20)
  // What the hub is actually addressed by, exclusions and all: the log should
  // say where an alert was sent, not where it would have gone without a call.
  // Phones are addressed by tag expression, so an exclusion has to travel inside
  // it: whoever was answered on a call, and whoever is off duty, cannot simply be
  // filtered out of a list after the fact.
  const excluded = [...held, ...duty.offDuty]
  const expression = hubTags.length > 0 ? tagExpressionFor(hubTags, excluded) : ''

  const data: Record<string, string> = { kind: record.kind }
  if (record.qrCodeId) data.qrCodeId = record.qrCodeId
  if (record.destination) data.destination = record.destination
  if (record.documentId) data.documentId = record.documentId

  const message = {
    title: record.title,
    body: record.body,
    priority: record.priority,
    tag: record.qrCodeId ? `qr-${record.qrCodeId}` : `notice-${record._id}`,
    data,
  }

  const url = record.kind === 'document' ? '/investor/files' : '/'

  // Which native platforms are worth a send. Read before the sends go out, so a
  // platform that registers mid-scan is simply picked up by the next alert.
  const platforms = await platformsFor(audience)

  const [browsers, hub] = await Promise.all([
    sendToBrowserSubscriptions(reachable, {
      ...message,
      // A document alert lands on the Files tab, which is where the thing it is
      // telling you about actually is.
      url,
    }),
    hubTags.length > 0
      ? sendByTags(hubTags, { ...message, url }, { excludeUserIds: excluded, platforms })
      : Promise.resolve(null),
  ])

  const sends: NotificationSend[] = []

  // One `browser` entry however many subscriptions answered: the log says
  // whether browsers were told, and the count would only be device bookkeeping.
  if (!browsers.skipped) {
    sends.push({
      channel: 'browser',
      ok: browsers.sent > 0,
      error:
        browsers.sent === 0
          ? browsers.errors[0] ?? 'No browser of theirs has alerts turned on'
          : undefined,
    })
  }

  for (const leg of hub?.legs ?? []) {
    sends.push({ channel: leg.channel, ok: leg.ok, error: leg.error })
  }

  const delivered = sends.filter((send) => send.ok).length
  const attempted = sends.length
  const update: Partial<NotificationRecord> = { sends, expression: expression || undefined }

  if (delivered > 0) {
    update.status = 'delivered'
    update.deliveredAt = new Date()
    update.note = `${delivered} of ${attempted} channel(s) accepted it.`
  } else if (attempted > 0) {
    update.status = 'failed'
    update.note = `Nothing could be reached: ${sends.find((send) => send.error)?.error ?? 'the push services refused it'}`
  } else if (audience.length === 0 && duty.offDuty.length > 0) {
    update.note =
      'Everyone this was addressed to is off duty: a support account only hears an alert while its session is open.'
  } else if (audience.length === 0) {
    update.note =
      record.kind === 'document'
        ? 'Nobody is in this file’s audience, so nobody was told.'
        : 'Nobody has one of these notification tags, so nobody was told.'
  } else {
    update.note =
      'Nobody who should be told has alerts turned on yet — no browser is subscribed and push is not configured on the server.'
  }

  await (await notifications()).updateOne(
    { _id: record._id },
    { $set: withDefined(update) },
  )

  console.log(
    `[notify] ${record.priority} ${record.kind} “${record.title}” → ${String(update.status ?? 'pending')} (${String(update.note)})`,
  )
}

/** `$set` with the empty values dropped, so an absent field stays absent. */
function withDefined(update: Partial<NotificationRecord>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined),
  )
}
