import { randomUUID } from 'node:crypto'

import { blobUploadSignature, blobUrl, containerClient } from './azure.ts'
import { db } from './db.ts'

/**
 * Kiosk Connect's devices and media, as the admin console manages them.
 *
 * v1's `lib/rtc/*`, moved here: the device registry, the media library and the
 * per-device playlist. v2's kiosk player reads it through the public bootstrap
 * route, and the console through the admin routes — the documents are v1's, so
 * a device keeps its identity and playlist either way.
 *
 * Media is uploaded the same way documents are: this API signs one write-only
 * blob in v1's `8l2r6y7n-open` container, the app uploads straight to Azure, and
 * the media row is only written once the bytes are there.
 */

const MEDIA_CONTAINER = '8l2r6y7n-open'
const MEDIA_FOLDER = 'rtcMedia/'
const MAX_BYTES = 200 * 1024 * 1024

const ALLOWED_TYPES: Record<string, { extension: string; mediaType: MediaType }> = {
  'image/png': { extension: 'png', mediaType: 'image' },
  'image/jpeg': { extension: 'jpg', mediaType: 'image' },
  'video/mp4': { extension: 'mp4', mediaType: 'video' },
  'video/x-msvideo': { extension: 'avi', mediaType: 'video' },
  'audio/mpeg': { extension: 'mp3', mediaType: 'audio' },
  'audio/wav': { extension: 'wav', mediaType: 'audio' },
  'audio/x-wav': { extension: 'wav', mediaType: 'audio' },
}

export type MediaType = 'image' | 'video' | 'audio'

export function isMediaType(value: unknown): value is MediaType {
  return value === 'image' || value === 'video' || value === 'audio'
}

/** The three collections behind Kiosk Connect, with v1's string ids. */
interface DeviceDocument {
  _id: string
  [field: string]: unknown
}

interface MediaDocument {
  _id: string
  [field: string]: unknown
}

interface ScheduleDocument {
  _id: string
  rtcDeviceId?: string
  rtcMediaId?: string
  priority?: number
  duration?: number
}

export interface RtcMedia {
  id: string
  name: string
  url: string
  mediaType: MediaType
  active: boolean
  createdAt: string | null
}

export interface RtcScheduleItem extends RtcMedia {
  /** The playlist row's own id — what Remove deletes. */
  scheduleId: string
  priority: number
  duration: number | null
}

export interface RtcDevice {
  id: string
  name: string
  hardwareMake: string
  hardwareModel: string
  hardwareSerial: string
  active: boolean
  onHoldImageId: string | null
  callStartToneId: string | null
  /**
   * The two media URLs the kiosk player needs, resolved from the library.
   * Only `rtcDevice()` fills them in; the console's registry list leaves them
   * null so listing devices stays one query.
   */
  onHoldImageUrl: string | null
  callStartToneUrl: string | null
  modified: string | null
  mediaSchedule: RtcScheduleItem[]
  /** The page a programmed kiosk opens — the device's own id, nothing secret. */
  kioskUrl: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value as string)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function mediaFromRow(row: Record<string, unknown>): RtcMedia {
  return {
    id: String(row._id),
    name: text(row.name),
    url: text(row.url),
    mediaType: isMediaType(row.mediaType) ? row.mediaType : 'image',
    active: row.active !== false,
    createdAt: isoOrNull(row.created),
  }
}

function deviceFromRow(row: Record<string, unknown>): RtcDevice {
  return {
    id: String(row._id),
    name: text(row.name),
    hardwareMake: text(row.hardwareMake),
    hardwareModel: text(row.hardwareModel),
    hardwareSerial: text(row.hardwareSerial),
    active: row.active !== false,
    onHoldImageId: row.onHoldImageId ? String(row.onHoldImageId) : null,
    callStartToneId: row.callStartToneId ? String(row.callStartToneId) : null,
    onHoldImageUrl: null,
    callStartToneUrl: null,
    modified: isoOrNull(row.modified),
    mediaSchedule: [],
    kioskUrl: deviceKioskUrl(String(row._id)),
  }
}

/**
 * Where a programmed kiosk goes.
 *
 * v1's player page, on the production site that already serves it, so a device
 * keeps working while this API takes over the registry; `KIOSK_PUBLIC_BASE_URL`
 * points it somewhere else without a code change.
 */
export function kioskBaseUrl(): string {
  return (process.env.KIOSK_PUBLIC_BASE_URL ?? 'https://app.inselfstorage.com').replace(/\/+$/, '')
}

export function deviceKioskUrl(id: string): string {
  return `${kioskBaseUrl()}/kioskconnect/kiosk/${id}`
}

export class RtcError extends Error {
  status: 400 | 404 | 409 | 413

  constructor(message: string, status: 400 | 404 | 409 | 413 = 400) {
    super(message)
    this.name = 'RtcError'
    this.status = status
  }
}

/** Active devices, by name. */
export async function rtcDevices(): Promise<RtcDevice[]> {
  const global = await db('global')
  const rows = await global.collection<DeviceDocument>('rtcDevices').find({ active: true }).toArray()

  return rows
    .map((row) => deviceFromRow(row))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
}

/** One device with its playlist, ordered the way it plays. */
export async function rtcDevice(deviceId: string): Promise<RtcDevice | null> {
  const global = await db('global')
  const row = await global.collection<DeviceDocument>('rtcDevices').findOne({ _id: deviceId })
  if (!row) return null

  const schedule = await global
    .collection<ScheduleDocument>('rtcMediaSchedule')
    .find({ rtcDeviceId: deviceId })
    .toArray()
  const mediaIds = schedule
    .map((item) => item.rtcMediaId)
    .filter((id): id is string => Boolean(id))
  const mediaRows = await global
    .collection<MediaDocument>('rtcMedia')
    .find({ _id: { $in: mediaIds } })
    .toArray()

  const items: RtcScheduleItem[] = mediaRows.map((media) => {
    const item = schedule.find((entry) => String(entry.rtcMediaId) === String(media._id))
    const duration = Number(item?.duration)
    return {
      ...mediaFromRow(media),
      scheduleId: String(item?._id ?? ''),
      priority: Number(item?.priority ?? 0),
      duration: Number.isFinite(duration) && item?.duration !== undefined ? duration : null,
    }
  })

  // The kiosk player shows these two without knowing the media library, so the
  // ids are resolved here rather than making the device fetch twice.
  const assetIds = [row.onHoldImageId, row.callStartToneId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const assets = assetIds.length
    ? await global
        .collection<MediaDocument>('rtcMedia')
        .find({ _id: { $in: assetIds } })
        .toArray()
    : []
  const urlOf = (id: unknown) => {
    if (typeof id !== 'string' || !id) return null
    const asset = assets.find((entry) => String(entry._id) === id)
    return asset ? text(asset.url) || null : null
  }

  return {
    ...deviceFromRow(row),
    onHoldImageUrl: urlOf(row.onHoldImageId),
    callStartToneUrl: urlOf(row.callStartToneId),
    mediaSchedule: items.sort((left, right) => left.priority - right.priority),
  }
}

export interface DeviceInput {
  name: string
  hardwareMake: string
  hardwareModel: string
  hardwareSerial: string
}

function checkDeviceInput(input: Partial<DeviceInput>) {
  if (input.name !== undefined && !input.name.trim()) throw new RtcError('Give the device a name')
  if (input.hardwareMake !== undefined && !input.hardwareMake.trim()) {
    throw new RtcError('Enter the hardware make')
  }
  if (input.hardwareModel !== undefined && !input.hardwareModel.trim()) {
    throw new RtcError('Enter the hardware model')
  }
  if (input.hardwareSerial !== undefined && !input.hardwareSerial.trim()) {
    throw new RtcError('Enter the hardware serial')
  }
}

export async function createRtcDevice(input: DeviceInput): Promise<RtcDevice> {
  checkDeviceInput(input)

  const global = await db('global')
  const id = randomUUID().replace(/-/g, '')
  const now = new Date()

  await global.collection<DeviceDocument>('rtcDevices').insertOne({
    _id: id,
    name: input.name.trim(),
    hardwareMake: input.hardwareMake.trim(),
    hardwareModel: input.hardwareModel.trim(),
    hardwareSerial: input.hardwareSerial.trim(),
    active: true,
    created: now,
    modified: now,
  })

  const device = await rtcDevice(id)
  if (!device) throw new RtcError('The device could not be created')
  return device
}

export interface DevicePatch extends Partial<DeviceInput> {
  onHoldImageId?: string | null
  callStartToneId?: string | null
  active?: boolean
}

export async function updateRtcDevice(
  deviceId: string,
  patch: DevicePatch,
): Promise<RtcDevice | null> {
  const global = await db('global')
  const existing = await global.collection<DeviceDocument>('rtcDevices').findOne({ _id: deviceId })
  if (!existing) return null

  checkDeviceInput(patch)

  const update: Record<string, unknown> = { modified: new Date() }
  for (const field of ['name', 'hardwareMake', 'hardwareModel', 'hardwareSerial'] as const) {
    const value = patch[field]
    if (value !== undefined) update[field] = value.trim()
  }
  if (patch.onHoldImageId !== undefined) update.onHoldImageId = patch.onHoldImageId
  if (patch.callStartToneId !== undefined) update.callStartToneId = patch.callStartToneId
  if (patch.active !== undefined) update.active = patch.active

  await global.collection<DeviceDocument>('rtcDevices').updateOne({ _id: deviceId }, { $set: update })
  return rtcDevice(deviceId)
}

/** Every media item, by name. */
export async function rtcMedia(): Promise<RtcMedia[]> {
  const global = await db('global')
  const rows = await global.collection<MediaDocument>('rtcMedia').find({}).toArray()

  return rows
    .map((row) => mediaFromRow(row))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
}

/** A write-only signature for one server-named media blob. */
export function mediaUploadSignature(contentType: string, fileName?: string) {
  const lowered = contentType.toLowerCase()
  const allowed =
    ALLOWED_TYPES[lowered] ??
    (lowered === 'application/octet-stream'
      ? Object.values(ALLOWED_TYPES).find(
          (entry) => entry.extension === (fileName ?? '').split('.').pop()?.toLowerCase(),
        )
      : undefined)

  if (!allowed) throw new RtcError('Upload an image, MP4/AVI video or MP3/WAV audio file')

  const blobName = `${MEDIA_FOLDER}${randomUUID()}.${allowed.extension}`
  const signature = blobUploadSignature(MEDIA_CONTAINER, blobName)

  return {
    blobName,
    blobUrl: signature.blobUrl,
    uploadUrl: signature.uploadUrl,
    expiresOn: signature.expiresOn,
    mediaType: allowed.mediaType,
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': ALLOWED_TYPES[lowered] ? contentType : 'application/octet-stream',
    },
  }
}

/** Records media for a blob that has finished uploading. */
export async function createRtcMedia(input: {
  blobName: string
  name: string
  mediaType: MediaType
}): Promise<RtcMedia> {
  if (
    !input.blobName.startsWith(MEDIA_FOLDER) ||
    input.blobName.includes('..') ||
    !/^[\w/.-]+$/.test(input.blobName)
  ) {
    throw new RtcError('Unknown upload')
  }
  if (!input.name.trim()) throw new RtcError('Give the file a name')

  const blob = containerClient(MEDIA_CONTAINER).getBlockBlobClient(input.blobName)
  let size = 0
  try {
    const properties = await blob.getProperties()
    size = properties.contentLength ?? 0
  } catch {
    throw new RtcError('The file had not finished uploading. Try again.', 409)
  }
  if (size <= 0) throw new RtcError('The file was empty. Try again.', 409)
  if (size > MAX_BYTES) {
    await blob.deleteIfExists().catch(() => undefined)
    throw new RtcError('Media must be 200 MB or smaller', 413)
  }

  const global = await db('global')
  const id = randomUUID().replace(/-/g, '')
  const now = new Date()

  await global.collection<MediaDocument>('rtcMedia').insertOne({
    _id: id,
    name: input.name.trim(),
    url: blobUrl(MEDIA_CONTAINER, input.blobName),
    mediaType: input.mediaType,
    blobName: input.blobName,
    container: MEDIA_CONTAINER,
    active: true,
    created: now,
    modified: now,
  })

  const rows = await global.collection<MediaDocument>('rtcMedia').find({ _id: id }).toArray()
  const media = rows.map((row) => mediaFromRow(row))[0]
  if (!media) throw new RtcError('The media could not be saved')
  return media
}

/** Removes media, its playlist entries and its bytes. */
export async function deleteRtcMedia(mediaId: string): Promise<boolean> {
  const global = await db('global')
  const row = await global.collection<MediaDocument>('rtcMedia').findOne({ _id: mediaId })
  if (!row) return false

  await global.collection<MediaDocument>('rtcMedia').deleteOne({ _id: mediaId })
  await global.collection<ScheduleDocument>('rtcMediaSchedule').deleteMany({ rtcMediaId: mediaId })
  await global
    .collection<DeviceDocument>('rtcDevices')
    .updateMany(
      { $or: [{ onHoldImageId: mediaId }, { callStartToneId: mediaId }] },
      { $unset: { onHoldImageId: '', callStartToneId: '' } },
    )

  const blobName = text(row.blobName)
  if (blobName) {
    await containerClient(text(row.container) || MEDIA_CONTAINER)
      .getBlockBlobClient(blobName)
      .deleteIfExists()
      .catch(() => undefined)
  }

  return true
}

/** Adds media to a device's playlist. */
export async function addScheduleItem(input: {
  deviceId: string
  mediaId: string
  priority: number
  duration?: number | null
}): Promise<RtcScheduleItem> {
  const global = await db('global')
  const device = await global.collection<DeviceDocument>('rtcDevices').findOne({ _id: input.deviceId })
  if (!device) throw new RtcError('That device does not exist', 404)
  const media = await global.collection<MediaDocument>('rtcMedia').findOne({ _id: input.mediaId })
  if (!media) throw new RtcError('That media does not exist', 404)

  if (!Number.isFinite(input.priority) || input.priority < 1) {
    throw new RtcError('Priority must be one or more; lower numbers play first')
  }
  if (input.duration !== undefined && input.duration !== null) {
    if (!Number.isFinite(input.duration) || input.duration < 1) {
      throw new RtcError('Duration must be one second or more')
    }
  }

  const id = randomUUID().replace(/-/g, '')
  await global.collection<ScheduleDocument>('rtcMediaSchedule').insertOne({
    _id: id,
    rtcDeviceId: input.deviceId,
    rtcMediaId: input.mediaId,
    priority: input.priority,
    ...(input.duration ? { duration: input.duration } : {}),
  })

  const device2 = await rtcDevice(input.deviceId)
  const item = device2?.mediaSchedule.find((entry) => entry.scheduleId === id)
  if (!item) throw new RtcError('The media could not be added')
  return item
}

/** Removes one playlist entry, but only from the device it belongs to. */
export async function deleteScheduleItem(deviceId: string, scheduleId: string): Promise<boolean> {
  const global = await db('global')
  const result = await global
    .collection<ScheduleDocument>('rtcMediaSchedule')
    .deleteOne({ _id: scheduleId, rtcDeviceId: deviceId })
  return result.deletedCount === 1
}
