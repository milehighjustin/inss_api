import { Hono } from 'hono'

import { requireUser } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import { PushError } from '../push/browser.ts'
import {
  removeInstallation,
  saveInstallation,
  userInstallations,
  type InstallationPlatform,
} from '../push/installations.ts'

/**
 * A phone registering to be told.
 *
 * The app posts once per install and again whenever something changes: a new
 * push token, new notification tags, or a foreground after a failed attempt. The
 * tags are never sent from the app — the server reads them off the account, so
 * nobody can subscribe themselves to a tag they were not given.
 *
 * Sign-out deletes the installation, because a shared phone that keeps receiving
 * the previous person's alerts is worse than no alerts at all.
 */

export const installationRoutes = new Hono()

function platformOf(value: unknown): InstallationPlatform | null {
  return value === 'ios' || value === 'android' ? value : null
}

/**
 * GET /api/mobile/notifications/devices
 *
 * Success: { devices } — the devices this account has alerts on. Used by the
 * Account screen to say "2 devices", and to let someone remove one.
 */
installationRoutes.get('/devices', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  return c.json({ devices: await userInstallations(user.userId) })
})

/**
 * POST /api/mobile/notifications/installations
 *
 * Body: { installationId, platform: 'ios' | 'android', pushChannel, appVersion?, deviceLabel? }
 * Success: { installation, synced }
 *
 * `synced: false` means the device is remembered but the hub has not accepted it
 * yet; the reconcile cron retries, and the app says "we'll keep trying" rather
 * than claiming alerts work.
 */
installationRoutes.post('/installations', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  const platform = platformOf(body.platform)
  if (!platform) return fail(c, 'A device must be an iPhone or an Android phone', 400)

  try {
    const result = await saveInstallation(user.userId, {
      installationId: text(body.installationId),
      platform,
      pushChannel: text(body.pushChannel),
      appVersion: text(body.appVersion),
      deviceLabel: text(body.deviceLabel),
    })

    return c.json(result)
  } catch (cause) {
    if (cause instanceof PushError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/**
 * DELETE /api/mobile/notifications/installations/:installationId
 *
 * Success: { deleted } — false when the device was already gone, which is the
 * outcome the caller wanted either way.
 */
installationRoutes.delete('/installations/:installationId', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  try {
    const deleted = await removeInstallation(user.userId, c.req.param('installationId'))
    return c.json({ deleted })
  } catch (cause) {
    if (cause instanceof PushError) return fail(c, cause.message, cause.status)
    throw cause
  }
})
