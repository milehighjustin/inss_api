import { Hono } from 'hono'

import { requireAdmin } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import { MAX_TAGS_PER_SEND, TagError, assertKnownTags, slugsOf } from '../notificationTags.ts'
import { notificationsForCode } from '../notifications.ts'
import {
  QrError,
  createQrCode,
  qrCode,
  qrCodeSvg,
  qrCodes,
  qrLinks,
  updateQrCode,
  type QrCode,
} from '../qr.ts'

/**
 * The QR codes, for administrators.
 *
 * A code is printed once and lives as long as its id, so this is: list, create,
 * change where it points, and take it out of service. A code can also ask for
 * support to be notified when it is scanned, with a message of the
 * administrator's own and a loud-or-quiet choice — the scan side of that lives
 * in `notifications.ts`, and the public pages are in `routes/qrPublic.ts`.
 *
 * The SVG comes from here too, so the picture and the public page always encode
 * the same address.
 */

export const qrRoutes = new Hono()

/** The links: the app's addresses for this code, the same whatever host serves it. */
function withLinks(code: QrCode) {
  return { ...code, links: qrLinks(code.id) }
}

/** Only the fields the caller actually sent, so a partial save stays partial. */
function notificationPatch(value: unknown): {
  title?: string
  body?: string
  priority?: 'loud' | 'quiet'
} | undefined {
  if (!value || typeof value !== 'object') return undefined

  const raw = value as Record<string, unknown>
  const patch: { title?: string; body?: string; priority?: 'loud' | 'quiet' } = {}

  if (typeof raw.title === 'string') patch.title = raw.title
  if (typeof raw.body === 'string') patch.body = raw.body
  if (raw.priority === 'loud' || raw.priority === 'quiet') patch.priority = raw.priority

  return patch
}

/** GET /api/mobile/admin/qr-codes */
qrRoutes.get('/', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const codes = await qrCodes(c.req.query('includeInactive') === '1')
  return c.json({ codes: codes.map((code) => withLinks(code)) })
})

/** POST /api/mobile/admin/qr-codes   { name, url } */
qrRoutes.post('/', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const code = await createQrCode(text(body.name), text(body.url))
    return c.json({ code: withLinks(code) }, 201)
  } catch (cause) {
    if (cause instanceof QrError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/**
 * PATCH /api/mobile/admin/qr-codes/:codeId
 *
 * Any subset of `{ name, url, active, locationId, rtcDeviceId, notifyTags, notifyUserIds, notification }`.
 * `locationId` and `rtcDeviceId` take an id or `null` to clear it; both are
 * checked against the property and kiosk collections, so a code cannot point at
 * a place or a screen that has been removed.
 * `notification` takes `{ title?, body?, priority }`, merged over what is
 * stored.
 *
 * There is no on/off flag: the tags are the audience, and the audience is the
 * switch. Choosing tags without a title is a 400, because that would be an alert
 * that says nothing.
 */
qrRoutes.patch('/:codeId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  const notification = notificationPatch(body.notification)
  const notifyTags = Array.isArray(body.notifyTags)
    ? slugsOf(body.notifyTags, MAX_TAGS_PER_SEND)
    : undefined

  try {
    // A tag that does not exist would be an audience nobody is in, so it is
    // refused rather than saved.
    if (notifyTags) await assertKnownTags(notifyTags)
    const code = await updateQrCode(c.req.param('codeId'), {
      ...(body.name !== undefined ? { name: text(body.name) } : {}),
      ...(body.url !== undefined ? { url: text(body.url) } : {}),
      ...(body.active !== undefined ? { active: body.active === true } : {}),
      ...(body.locationId !== undefined
        ? { locationId: typeof body.locationId === 'string' ? body.locationId : null }
        : {}),
      ...(body.rtcDeviceId !== undefined
        ? { rtcDeviceId: typeof body.rtcDeviceId === 'string' ? body.rtcDeviceId : null }
        : {}),
      ...(notifyTags !== undefined ? { notifyTags } : {}),
      ...(notification !== undefined ? { notification } : {}),
      ...(Array.isArray(body.notifyUserIds)
        ? {
            notifyUserIds: body.notifyUserIds.filter(
              (id): id is string => typeof id === 'string' && Boolean(id.trim()),
            ),
          }
        : {}),
    })

    if (!code) return fail(c, 'That code is not there', 404)
    return c.json({ code: withLinks(code) })
  } catch (cause) {
    if (cause instanceof QrError) return fail(c, cause.message, cause.status)
    if (cause instanceof TagError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/**
 * GET /api/mobile/admin/qr-codes/:codeId/notifications?limit=10
 *
 * Success: { notifications } — the alerts this code raised, newest first.
 *
 * What an administrator actually wants to know about a sign: is it being scanned,
 * what went out, and did it arrive. A row suppressed inside the quiet window
 * counts as a scan without being an alert, which is why it is in the list.
 */
qrRoutes.get('/:codeId/notifications', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const codeId = c.req.param('codeId')
  const code = await qrCode(codeId)
  if (!code) return fail(c, 'That code is not there', 404)

  const limit = Number(c.req.query('limit') ?? '10')
  return c.json({
    notifications: await notificationsForCode(codeId, Number.isFinite(limit) ? limit : 10),
  })
})

/**
 * GET /api/mobile/admin/qr-codes/:codeId/svg
 *
 * Success: { svg } — the same drawing as the image route, as a string. Native
 * clients cannot put an `Authorization` header on an image source, so they fetch
 * this and draw it with their own SVG renderer.
 */
qrRoutes.get('/:codeId/svg', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const svg = await qrCodeSvg(c.req.param('codeId'))
  if (!svg) return fail(c, 'That code is not there', 404)

  return c.json({ svg })
})

/**
 * GET /api/mobile/admin/qr-codes/:codeId/image
 *
 * The code itself, as SVG. Fetched with the session token and drawn by the app,
 * rather than an <img> URL that would have to carry a credential.
 */
qrRoutes.get('/:codeId/image', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const svg = await qrCodeSvg(c.req.param('codeId'))
  if (!svg) return fail(c, 'That code is not there', 404)

  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(svg, 'utf8')),
  })
})
