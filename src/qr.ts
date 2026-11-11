import { randomUUID } from 'node:crypto'

import QRCode from 'qrcode'

import { db } from './db.ts'

/**
 * The QR codes people scan at a property.
 *
 * A code is a stable id plus the address it forwards to, so a printed sign never
 * has to be replaced: change the destination here and every copy of the code
 * points somewhere new. The codes live in v1's `global.qr` collection with the
 * same id shape (a bare uuid), because printed codes already exist against those
 * ids. The pages they open (`/qr/:id` and `/qr/:id/kiosk`) belong to the app, so
 * the hostname on a sign never depends on this service; what lives here is the
 * destination and the drawing, which the app asks for.
 *
 * A code can also ask for support to be told when someone scans it: who to
 * notify, what the message says, and whether it should be loud or quiet. The
 * scan itself is recorded by `notifications.ts`.
 */

/** How the message should arrive: `loud` interrupts, `quiet` arrives silently. */
export type QrNotificationPriority = 'loud' | 'quiet'

/** The most tags one push expression may contain, people included. */
const MAX_EXPRESSION_TAGS = 20

/** The message sent when a code is scanned, if the code asks for one. */
export interface QrNotification {
  title: string
  body: string
  priority: QrNotificationPriority
}

interface QrDocument {
  _id: string
  name?: string
  url?: string
  active?: boolean
  createdAt?: Date | string
  locationId?: unknown
  rtcDeviceId?: unknown
  notifyTags?: unknown
  notifyUserIds?: unknown
  notification?: { title?: unknown; body?: unknown; priority?: unknown }
}

export interface QrCode {
  id: string
  name: string
  url: string
  active: boolean
  createdAt: string | null
  /**
   * The property this code stands at, when one is chosen.
   *
   * It is what makes a scan a fact about a place rather than about a sign: the
   * alert can say where someone is, and performance can be read per property
   * without matching on a code's name.
   */
  locationId: string | null
  /**
   * The video kiosk beside this sign, if there is one.
   *
   * Answering an alert from this code can then start a call on that device,
   * which is the whole point of pairing them: the person who scanned a sign is
   * standing in front of the screen that can see them.
   */
  rtcDeviceId: string | null
  /**
   * The tags told on each scan. This list *is* the audience and the switch: a
   * code with tags notifies them, and a code with none simply redirects. There is
   * no on/off field, because a switch beside an audience is two answers to one
   * question and the stored one could read "yes" while pointing at nobody.
   */
  notifyTags: string[]
  /** Named accounts, from before tags existed. Still honoured. */
  notifyUserIds: string[]
  notification: QrNotification
}

/**
 * The message a code starts with: nothing, and quiet.
 *
 * Quiet is the default on purpose. Turning notifications on says a scan is worth
 * telling someone about; it should not also start making phones ring until that
 * is asked for.
 */
const NO_MESSAGE: QrNotification = { title: '', body: '', priority: 'quiet' }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function priorityOf(value: unknown): QrNotificationPriority {
  return value === 'loud' ? 'loud' : 'quiet'
}

/** The recipient ids, as a clean list: strings, trimmed, no repeats. */
function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  for (const entry of value) {
    const id = text(entry)
    if (id) seen.add(id)
  }
  return [...seen]
}

function notificationOf(row: QrDocument): QrNotification {
  const notification = row.notification
  if (!notification) return { ...NO_MESSAGE }

  return {
    title: text(notification.title),
    body: text(notification.body),
    priority: priorityOf(notification.priority),
  }
}

function codeFromRow(row: QrDocument): QrCode {
  const notifyTags = idsOf(row.notifyTags)
  const notifyUserIds = idsOf(row.notifyUserIds)

  return {
    id: String(row._id),
    name: text(row.name),
    url: text(row.url),
    active: row.active !== false,
    createdAt: row.createdAt ? new Date(row.createdAt as string).toISOString() : null,
    locationId: text(row.locationId) || null,
    rtcDeviceId: text(row.rtcDeviceId) || null,
    notifyTags,
    notifyUserIds,
    notification: notificationOf(row),
  }
}

/**
 * Where the public pages live: the app's production host, and nothing else.
 *
 * A printed code is permanent, so the hostname inside it has to be permanent too.
 * That is why this is a constant and not configuration: a code drawn on a
 * development build still has to work when it is photographed, printed and
 * scanned by somebody else, so the image may never carry whichever host happened
 * to serve the machine that drew it. Not `API_URL`, not the request's own origin
 * (both are this service, behind a proxy), and not an environment variable — an
 * override is exactly the thing that makes a code point somewhere that only
 * exists on one laptop.
 *
 * `/qr/:id` and `/qr/:id/kiosk` are the app's routes on this host. Changing it
 * means reprinting every sign, which is why it lives in one place, here.
 */
const QR_PUBLIC_HOST = 'https://app.inselfstorage.com'

export function qrBaseUrl(): string {
  return QR_PUBLIC_HOST
}

/** The address a code resolves to, and the page that displays it. */
export function qrLinks(id: string): { code: string; kiosk: string } {
  const base = qrBaseUrl()
  return { code: `${base}/qr/${id}`, kiosk: `${base}/qr/${id}/kiosk` }
}

/** Every code, active ones only unless `includeInactive` is asked for. */
export async function qrCodes(includeInactive = false): Promise<QrCode[]> {
  const global = await db('global')
  const query = includeInactive ? {} : { active: true }
  const rows = await global.collection<QrDocument>('qr').find(query).toArray()

  return rows
    .map((row) => codeFromRow(row))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
}

/** One code, whatever its state — the public pages decide what that means. */
export async function qrCode(id: string): Promise<QrCode | null> {
  const global = await db('global')
  const row = await global.collection<QrDocument>('qr').findOne({ _id: id })
  return row ? codeFromRow(row) : null
}

export class QrError extends Error {
  status: 400 | 404

  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.name = 'QrError'
    this.status = status
  }
}

/**
 * The property and the kiosk are checked on save, not on read.
 *
 * A code pointing at a property that has been deleted, or at a screen that was
 * removed, is a setting that silently does nothing — the alert would say
 * "somewhere" and answering it would offer a call to nothing.
 */
async function assertLocation(locationId: string): Promise<void> {
  const row = await (await db('loglady'))
    .collection<{ _id: string }>('locations')
    .findOne({ _id: locationId })
  if (!row) throw new QrError('That property is not there', 404)
}

async function assertRtcDevice(deviceId: string): Promise<void> {
  const row = await (await db('global'))
    .collection<{ _id: string }>('rtcDevices')
    .findOne({ _id: deviceId })
  if (!row) throw new QrError('That kiosk is not there', 404)
}

/**
 * The names behind a code's location and kiosk, for an alert that has to say
 * where someone is without the phone having to look them up.
 */
export async function qrNames(
  code: Pick<QrCode, 'locationId' | 'rtcDeviceId'>,
): Promise<{ locationName: string; rtcDeviceName: string }> {
  const names = { locationName: '', rtcDeviceName: '' }

  if (code.locationId) {
    const row = await (await db('loglady'))
      .collection<{ _id: string; name?: unknown }>('locations')
      .findOne({ _id: code.locationId })
    names.locationName = text(row?.name)
  }

  if (code.rtcDeviceId) {
    const row = await (await db('global'))
      .collection<{ _id: string; name?: unknown }>('rtcDevices')
      .findOne({ _id: code.rtcDeviceId })
    names.rtcDeviceName = text(row?.name)
  }

  return names
}

function checkUrl(value: string): string {
  if (!value) throw new QrError('A destination URL is required')
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('not http')
  } catch {
    throw new QrError('The destination must be an http or https address')
  }
  return value
}

export async function createQrCode(name: string, url: string): Promise<QrCode> {
  if (!name) throw new QrError('Name the code')

  const global = await db('global')
  const id = randomUUID().replace(/-/g, '')
  const now = new Date()

  await global.collection<QrDocument>('qr').insertOne({
    _id: id,
    name,
    url: checkUrl(url),
    active: true,
    createdAt: now,
    notifyTags: [],
    notifyUserIds: [],
    notification: { ...NO_MESSAGE },
  })

  return {
    id,
    name,
    url,
    active: true,
    createdAt: now.toISOString(),
    locationId: null,
    rtcDeviceId: null,
    notifyTags: [],
    notifyUserIds: [],
    notification: { ...NO_MESSAGE },
  }
}

export interface QrCodePatch {
  name?: string
  url?: string
  active?: boolean
  /** An id, or null to clear it when the sign has no property or no screen. */
  locationId?: string | null
  rtcDeviceId?: string | null
  notifyTags?: string[]
  notifyUserIds?: string[]
  notification?: { title?: string; body?: string; priority?: QrNotificationPriority }
}

/**
 * Changes where a code points, or which tags it tells when it is scanned.
 *
 * Notification fields merge onto what is stored, so a form can save a title
 * without restating the tags. The message is checked against the *resulting*
 * audience: tags without a title would be an alert that says nothing, so it is
 * refused instead.
 */
export async function updateQrCode(id: string, patch: QrCodePatch): Promise<QrCode | null> {
  const global = await db('global')
  const collection = global.collection<QrDocument>('qr')
  const existing = await collection.findOne({ _id: id })
  if (!existing) return null

  const current = codeFromRow(existing)
  const update: Record<string, unknown> = {}

  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new QrError('Name the code')
    update.name = patch.name.trim()
  }
  if (patch.url !== undefined) update.url = checkUrl(patch.url)
  if (patch.active !== undefined) update.active = patch.active

  if (patch.locationId !== undefined) {
    const locationId = text(patch.locationId) || null
    if (locationId) await assertLocation(locationId)
    update.locationId = locationId
  }
  if (patch.rtcDeviceId !== undefined) {
    const rtcDeviceId = text(patch.rtcDeviceId) || null
    if (rtcDeviceId) await assertRtcDevice(rtcDeviceId)
    update.rtcDeviceId = rtcDeviceId
  }

  const notification: QrNotification = {
    title: patch.notification?.title !== undefined ? text(patch.notification.title) : current.notification.title,
    body: patch.notification?.body !== undefined ? text(patch.notification.body) : current.notification.body,
    priority: patch.notification?.priority ?? current.notification.priority,
  }
  const notifyTags = patch.notifyTags ?? current.notifyTags
  const notifyUserIds = patch.notifyUserIds ?? current.notifyUserIds
  const notifying = notifyTags.length + notifyUserIds.length > 0

  if (patch.notification !== undefined) update.notification = notification
  if (patch.notifyTags !== undefined) update.notifyTags = notifyTags
  if (patch.notifyUserIds !== undefined) update.notifyUserIds = notifyUserIds

  if (notifying) {
    if (!notification.title) {
      throw new QrError('Give the notification a title before choosing who it tells')
    }
    // Azure takes at most twenty tags in one OR expression, and a named person
    // is one of them. Authoring time is the only place this can be explained.
    if (notifyTags.length + notifyUserIds.length > MAX_EXPRESSION_TAGS) {
      throw new QrError(
        `Choose at most ${MAX_EXPRESSION_TAGS} tags and people together — that is the push service's limit for one send`,
      )
    }
  }

  if (Object.keys(update).length > 0) {
    await collection.updateOne({ _id: id }, { $set: update })
  }

  const row = await collection.findOne({ _id: id })
  return row ? codeFromRow(row) : null
}

/**
 * The code as an SVG.
 *
 * Drawn here rather than in the app so the file is identical whichever platform
 * prints it, and so the image is generated from the id the public page reads.
 */
export async function qrCodeSvg(id: string): Promise<string | null> {
  const global = await db('global')
  const row = await global.collection<QrDocument>('qr').findOne({ _id: id })
  if (!row) return null

  return QRCode.toString(qrLinks(id).code, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 2,
    color: { dark: '#004F71', light: '#FFFFFF' },
  })
}
