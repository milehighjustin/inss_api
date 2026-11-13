import { Hono } from 'hono'

import { requireRoles, type SessionUser } from '../auth/session.ts'
import { alertLog } from '../alertLog.ts'
import { DeskAlertError, claimDeskAlert } from '../deskAlerts.ts'
import { fail } from '../http.ts'
import {
  SESSION_STAFF_ROLES,
  SUPPORT_ROLES,
  activeSessions,
  endSession,
  mySession,
  sessionById,
  sessionHistory,
  startSession,
} from '../support.ts'

/**
 * The Support panel's API.
 *
 * Two audiences:
 *
 * - **Your own shift** — start it, end it, read it, and read the list of your own
 *   past ones. Anyone the Support panel is open to, which is the support group
 *   plus the people who may also take a shift.
 * - **Everyone's shifts** — the live list and the history of every account.
 *   Administrators, managers and supervisors, which is what Admin → Support
 *   shows. The history route below narrows a non-staff caller to their own rows
 *   rather than refusing them, so the desk's own page can page through its
 *   shifts without a second endpoint.
 */

export const supportRoutes = new Hono()

/** GET /api/mobile/support/session — the shift this account has open, or null. */
supportRoutes.get('/session', async (c) => {
  const user = await requireRoles(c, SUPPORT_ROLES)
  if (user instanceof Response) return user

  return c.json({ session: await mySession(user.userId) })
})

/**
 * POST /api/mobile/support/sessions
 *
 * Success: { session, replaced } (201)
 *
 * `replaced` is true when a shift was already open and this one took over, so
 * the app can say that rather than pretend nothing happened.
 */
supportRoutes.post('/sessions', async (c) => {
  const user = await requireRoles(c, SUPPORT_ROLES)
  if (user instanceof Response) return user

  return c.json(await startSession(user), 201)
})

/**
 * POST /api/mobile/support/sessions/end
 *
 * Success: { session } — null when nothing was open. Ending a shift that is
 * already over is not an error: it is the state the caller asked for.
 */
supportRoutes.post('/sessions/end', async (c) => {
  const user = await requireRoles(c, SUPPORT_ROLES)
  if (user instanceof Response) return user

  return c.json({ session: await endSession(user.userId) })
})

/**
 * GET /api/mobile/support/alerts?page=&pageSize=
 *
 * Success: { alerts, total, page, pageSize, counts, people } — every alert
 * addressed to this person's tags, newest first, twenty-five to a page, with what
 * became of each. `canAccept` is the one that matters: true when nobody has
 * answered, this person has not settled it, and it is still inside the five
 * minutes — exactly the alert they can take from the list.
 */
supportRoutes.get('/alerts', async (c) => {
  const user = await requireRoles(c, SUPPORT_ROLES)
  if (user instanceof Response) return user

  const page = Number(c.req.query('page') ?? '1')
  const pageSize = Number(c.req.query('pageSize') ?? '')

  return c.json(
    await alertLog({
      mine: user,
      page: Number.isFinite(page) && page > 0 ? page : 1,
      ...(Number.isFinite(pageSize) && pageSize > 0 ? { pageSize } : {}),
    }),
  )
})

/**
 * POST /api/mobile/support/alerts/:notificationId/claim
 *
 * Success: { alert } — the board row, now answered by this person.
 *
 * 403 when the alert was never addressed to them, 409 when somebody else has
 * already answered it. Claiming one they settled already is not an error: it
 * answers with the row as it stands instead of recording a second answer.
 */
supportRoutes.post('/alerts/:notificationId/claim', async (c) => {
  const user = await requireRoles(c, SUPPORT_ROLES)
  if (user instanceof Response) return user

  try {
    const alert = await claimDeskAlert(user, c.req.param('notificationId'))
    return c.json({ alert })
  } catch (cause) {
    if (cause instanceof DeskAlertError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/**
 * GET /api/mobile/support/sessions/active
 *
 * Success: { sessions } — everyone on duty now, longest-serving first, with how
 * long they have been on and what has happened so far.
 */
supportRoutes.get('/sessions/active', async (c) => {
  const gate = await staff(c)
  if (gate instanceof Response) return gate

  return c.json({ sessions: await activeSessions() })
})

/**
 * GET /api/mobile/support/sessions?page=&pageSize=&userId=
 *
 * Success: { sessions, total, page, pageSize } — newest first, 25 to a page by
 * default. `userId` is how the performance report drills into one person, and it
 * is ignored for a caller who may not read everyone: they get their own history.
 */
supportRoutes.get('/sessions', async (c) => {
  const user = await requireRoles(c, SUPPORT_ROLES)
  if (user instanceof Response) return user

  const staff = SESSION_STAFF_ROLES.some((role) => user.roles.includes(role))
  const asked = c.req.query('userId')?.trim()
  const userId = staff ? asked : user.userId

  const page = Number(c.req.query('page') ?? '1')
  const pageSize = Number(c.req.query('pageSize') ?? '')

  return c.json(
    await sessionHistory({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      ...(Number.isFinite(pageSize) && pageSize > 0 ? { pageSize } : {}),
      ...(userId ? { userId } : {}),
    }),
  )
})

/**
 * GET /api/mobile/support/sessions/:sessionId
 *
 * Success: { session } — the full picture for one shift: what reached them, what
 * they clicked, how fast, and what the calls after those answers lasted.
 *
 * Staff read anyone's; a support account reads its own and nothing else.
 */
supportRoutes.get('/sessions/:sessionId', async (c) => {
  const user = await requireRoles(c, SUPPORT_ROLES)
  if (user instanceof Response) return user

  const session = await sessionById(c.req.param('sessionId'))
  if (!session) return fail(c, 'That session is not there', 404)

  const staff = SESSION_STAFF_ROLES.some((role) => user.roles.includes(role))
  if (!staff && session.userId !== user.userId) {
    return fail(c, 'You do not have access to this', 403)
  }

  return c.json({ session })
})

/** The caller as someone who may see every session. */
async function staff(c: Parameters<typeof requireRoles>[0]): Promise<SessionUser | Response> {
  return requireRoles(c, SESSION_STAFF_ROLES)
}
