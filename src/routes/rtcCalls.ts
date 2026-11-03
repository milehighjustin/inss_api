import { Hono } from 'hono'

import { requireRoles } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import { iceServers } from '../rtcIceServers.ts'
import { RtcError, rtcDevice } from '../rtc.ts'
import { uploadPhotoToDrive } from '../rtcPhotos.ts'
import { mintKioskToken, mintOperatorToken } from '../rtcTokens.ts'

/**
 * Getting a socket: the two ways in, and the ICE servers to call with.
 *
 * The signaling socket itself is mounted in `index.ts`, on the same port as this
 * API. These routes hand out what a peer needs before it connects — a token, the
 * TURN credentials and, for a kiosk, the device and playlist to show while it
 * waits — so neither the website nor the app has to mint tokens of its own.
 */

/** Who may place calls from the console: v1's Kiosk Connect audience. */
const OPERATOR_ROLES = ['administrator', 'developer', 'manager', 'supervisor'] as const

export const rtcCallRoutes = new Hono()

/** POST /api/mobile/rtc/token — an operator's socket token and ICE servers. */
rtcCallRoutes.post('/token', async (c) => {
  const user = await requireRoles(c, OPERATOR_ROLES)
  if (user instanceof Response) return user

  try {
    const { token, expiresOn } = mintOperatorToken({ userId: user.userId, roles: user.roles })
    return c.json({ token, expiresOn, iceServers: await iceServers() })
  } catch (cause) {
    return fail(c, cause instanceof Error ? cause.message : 'Calling is not configured', 500)
  }
})

/**
 * GET /api/mobile/rtc/kiosk/:deviceId — a device's socket token, its playlist
 * and the ICE servers.
 *
 * Public, like the page a kiosk loads: the device id is what a programmed kiosk
 * was given, and a kiosk has no user to sign in as. A device that has been
 * deactivated is refused, so retiring one is enough to cut it off.
 */
rtcCallRoutes.get('/kiosk/:deviceId', async (c) => {
  const device = await rtcDevice(c.req.param('deviceId'))
  if (!device || !device.active) return fail(c, 'That kiosk is not there', 404)

  try {
    const { token, expiresOn } = mintKioskToken(device.id)
    return c.json({ token, expiresOn, iceServers: await iceServers(), device })
  } catch (cause) {
    return fail(c, cause instanceof Error ? cause.message : 'Calling is not configured', 500)
  }
})

/**
 * POST /api/mobile/rtc/photos   { dataUrl, fileName }
 *
 * The photo tool captures a frame from the kiosk's camera and files it. v1 did
 * this from a Next server action; the Drive upload is here now, with the same
 * service account and the same name the operator typed.
 */
rtcCallRoutes.post('/photos', async (c) => {
  const user = await requireRoles(c, OPERATOR_ROLES)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const file = await uploadPhotoToDrive({
      dataUrl: text(body.dataUrl),
      fileName: text(body.fileName),
    })
    return c.json({ file })
  } catch (cause) {
    if (cause instanceof RtcError) return fail(c, cause.message, cause.status)
    console.error('[rtc] photo upload failed:', cause)
    return fail(
      c,
      cause instanceof Error ? cause.message : 'The photo could not be saved',
      500,
    )
  }
})
