import { Hono } from 'hono'

import { acknowledgeAlert, performance } from '../activity.ts'
import { requireRoles, requireUser } from '../auth/session.ts'
import { readJson } from '../http.ts'

/**
 * What people did with an alert, and the report over it.
 *
 * Two audiences, two paths. `POST /api/mobile/alerts/:id/acknowledge` is for the
 * person who was rung — answering or ignoring is their own act and needs nothing
 * but their session. The report is for whoever is responsible for the desk:
 * administrators, managers and supervisors, the same people who read the KPI
 * board.
 */

/**
 * The roles that may read the performance report.
 *
 * The report lives in the Support panel now, but the panel is a container, not a
 * widening: the same three roles read it there that read it in Admin, and the
 * support group sees their own shift on their own screen.
 */
const REPORT_ROLES = ['administrator', 'manager', 'supervisor'] as const

export const alertRoutes = new Hono()

/** `{ outcome }` → whether it was recorded. */
alertRoutes.post('/:notificationId/acknowledge', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  const outcome = body.outcome === 'ignored' ? 'ignored' : 'answered'

  const recorded = await acknowledgeAlert(c.req.param('notificationId'), user.userId, outcome)

  // 404 when this person was never offered this alert: a replayed or invented
  // click must not create a response time.
  if (!recorded) return c.json({ error: 'That alert was not offered to you' }, 404)

  return c.json({ recorded: true, outcome })
})

export const performanceRoutes = new Hono()

/**
 * GET /api/mobile/admin/performance?days=30
 *
 * `{ totals, people, locations }` over the window — `from`/`to` override `days`
 * when a caller wants an exact range.
 *
 * Every number comes from the activity log rather than from the notification
 * rows: an alert says what was sent, this says what was answered, how fast, and
 * what the call after it lasted.
 */
performanceRoutes.get('/', async (c) => {
  const user = await requireRoles(c, REPORT_ROLES)
  if (user instanceof Response) return user

  const { from, to } = windowFor(c.req.query('days'), c.req.query('from'), c.req.query('to'))
  return c.json(await performance(from, to))
})

function windowFor(daysRaw?: string, fromRaw?: string, toRaw?: string): { from: Date; to: Date } {
  const now = new Date()
  const to = parseDay(toRaw) ?? now

  const explicitFrom = parseDay(fromRaw)
  if (explicitFrom) return { from: explicitFrom, to }

  const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 366)
  return { from: new Date(to.getTime() - days * 24 * 60 * 60 * 1000), to }
}

/** `YYYY-MM-DD` (or an ISO timestamp) at the start of its day, or null. */
function parseDay(value?: string): Date | null {
  if (!value) return null

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

