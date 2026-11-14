import { Hono } from 'hono'

import { requireAdmin } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import {
  RtcError,
  addScheduleItem,
  createRtcDevice,
  createRtcMedia,
  deleteRtcMedia,
  deleteScheduleItem,
  isMediaType,
  mediaUploadSignature,
  rtcDevice,
  rtcDevices,
  rtcMedia,
  updateRtcDevice,
} from '../rtc.ts'
import { refreshRtcDevices } from '../rtcSignaling.ts'

/**
 * Kiosk Connect's devices, media and playlists, for administrators.
 *
 * This is the registry the admin console maintains in v1's collections. A kiosk
 * itself reads its own row, playlist and media URLs through the public
 * `/api/mobile/rtc/kiosk/:deviceId` route, not these.
 */

export const rtcRoutes = new Hono()

/**
 * GET /api/mobile/admin/rtc/devices — active devices, by name.
 *
 * `?includeInactive=1` adds the deactivated ones, which the console lists so a
 * device retired by mistake can be brought back. Everything else (the kiosk
 * player, the placement pickers) leaves them out.
 */
rtcRoutes.get('/devices', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ devices: await rtcDevices(c.req.query('includeInactive') === '1') })
})

/** GET /api/mobile/admin/rtc/devices/:deviceId — with its playlist. */
rtcRoutes.get('/devices/:deviceId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const device = await rtcDevice(c.req.param('deviceId'))
  if (!device) return fail(c, 'That device is not there', 404)

  return c.json({ device })
})

/** POST /api/mobile/admin/rtc/devices   { name, hardwareMake, hardwareModel, hardwareSerial } */
rtcRoutes.post('/devices', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const device = await createRtcDevice({
      name: text(body.name),
      hardwareMake: text(body.hardwareMake),
      hardwareModel: text(body.hardwareModel),
      hardwareSerial: text(body.hardwareSerial),
    })
    // A console that is open right now should see the new device without
    // reconnecting: its list comes from the socket.
    void refreshRtcDevices().catch(() => undefined)
    return c.json({ device }, 201)
  } catch (cause) {
    if (cause instanceof RtcError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** PATCH /api/mobile/admin/rtc/devices/:deviceId */
rtcRoutes.patch('/devices/:deviceId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const device = await updateRtcDevice(c.req.param('deviceId'), {
      ...(body.name !== undefined ? { name: text(body.name) } : {}),
      ...(body.hardwareMake !== undefined ? { hardwareMake: text(body.hardwareMake) } : {}),
      ...(body.hardwareModel !== undefined ? { hardwareModel: text(body.hardwareModel) } : {}),
      ...(body.hardwareSerial !== undefined ? { hardwareSerial: text(body.hardwareSerial) } : {}),
      ...(body.onHoldImageId !== undefined
        ? { onHoldImageId: text(body.onHoldImageId) || null }
        : {}),
      ...(body.callStartToneId !== undefined
        ? { callStartToneId: text(body.callStartToneId) || null }
        : {}),
      ...(body.active !== undefined ? { active: body.active === true } : {}),
    })

    if (!device) return fail(c, 'That device is not there', 404)
    if (body.active !== undefined) void refreshRtcDevices().catch(() => undefined)
    return c.json({ device })
  } catch (cause) {
    if (cause instanceof RtcError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** POST /api/mobile/admin/rtc/devices/:deviceId/schedule   { rtcMediaId, priority, duration? } */
rtcRoutes.post('/devices/:deviceId/schedule', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const item = await addScheduleItem({
      deviceId: c.req.param('deviceId'),
      mediaId: text(body.rtcMediaId),
      priority: Number(body.priority),
      duration: body.duration === undefined || body.duration === null ? null : Number(body.duration),
    })
    return c.json({ item }, 201)
  } catch (cause) {
    if (cause instanceof RtcError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** DELETE /api/mobile/admin/rtc/devices/:deviceId/schedule/:scheduleId */
rtcRoutes.delete('/devices/:deviceId/schedule/:scheduleId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const deleted = await deleteScheduleItem(
    c.req.param('deviceId'),
    c.req.param('scheduleId'),
  )
  if (!deleted) return fail(c, 'That playlist entry is not there', 404)

  return c.json({ deleted: true })
})

/** GET /api/mobile/admin/rtc/media */
rtcRoutes.get('/media', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ media: await rtcMedia() })
})

/** POST /api/mobile/admin/rtc/media/upload   { contentType, fileName? } */
rtcRoutes.post('/media/upload', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const upload = mediaUploadSignature(text(body.contentType), text(body.fileName) || undefined)
    return c.json({ upload })
  } catch (cause) {
    if (cause instanceof RtcError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** POST /api/mobile/admin/rtc/media   { blobName, name, mediaType } */
rtcRoutes.post('/media', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  if (!isMediaType(body.mediaType)) return fail(c, 'Choose the media type', 400)

  try {
    const media = await createRtcMedia({
      blobName: text(body.blobName),
      name: text(body.name),
      mediaType: body.mediaType,
    })
    return c.json({ media }, 201)
  } catch (cause) {
    if (cause instanceof RtcError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** DELETE /api/mobile/admin/rtc/media/:mediaId */
rtcRoutes.delete('/media/:mediaId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const deleted = await deleteRtcMedia(c.req.param('mediaId'))
  if (!deleted) return fail(c, 'That media is not there', 404)

  return c.json({ deleted: true })
})
