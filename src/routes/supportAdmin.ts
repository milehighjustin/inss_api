import { Hono } from 'hono'

import { personActivity, personDaily, performance } from '../activity.ts'
import { alertLog, type AlertActionFilter } from '../alertLog.ts'
import { requireAdmin, requireRoles } from '../auth/session.ts'
import { peopleById, userShifts } from '../support.ts'

/**
 * Admin → Support's API: every alert, for administrators.
 *
 * The desk's own list is `/api/mobile/support/alerts`, narrowed to the alerts
 * addressed to the caller. This one is the other side of the same table — the
 * whole log, searchable, filterable by what happened to it and by who answered
 * it — and it is administrator-only, like the panel it feeds.
 */

export const supportAdminRoutes = new Hono()

const ACTIONS: AlertActionFilter[] = ['all', 'answered', 'ignored', 'expired', 'waiting']

/** Who may read the desk's numbers: the same three roles as the report. */
const REPORT_ROLES = ['administrator', 'manager', 'supervisor'] as const

/**
 * GET /api/mobile/admin/support/alerts?page=&pageSize=&q=&action=&answeredBy=&days=
 *
 * Success: { alerts, total, page, pageSize, counts, people } — newest first,
 * twenty-five to a page.
 *
 * `counts` is how many rows each action would show under the current search, so
 * the filter can say "Answered (12)" before it is applied, and `people` is the
 * list of accounts who answered under that search.
 */
supportAdminRoutes.get('/alerts', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const page = Number(c.req.query('page') ?? '1')
  const pageSize = Number(c.req.query('pageSize') ?? '')
  const days = Number(c.req.query('days') ?? '')
  const asked = c.req.query('action') ?? 'all'
  const action = (ACTIONS as string[]).includes(asked) ? (asked as AlertActionFilter) : 'all'
  const q = c.req.query('q')?.trim()
  const answeredBy = c.req.query('answeredBy')?.trim()

  return c.json(
    await alertLog({
      action,
      page: Number.isFinite(page) && page > 0 ? page : 1,
      ...(Number.isFinite(pageSize) && pageSize > 0 ? { pageSize } : {}),
      ...(Number.isFinite(days) && days > 0 ? { days } : {}),
      ...(q ? { q } : {}),
      ...(answeredBy ? { answeredBy } : {}),
    }),
  )
})

/**
 * GET /api/mobile/admin/support/people/:userId?days=30
 *
 * Everything we know about one person's desk work, and the same numbers for the
 * people they work beside.
 *
 * `activity` is the window's tally (offered, held, answered, ignored, missed,
 * response times, calls, clicks), `daily` is that tally cut into calendar days
 * including the quiet ones, and `shifts` is how much of the window they actually
 * held the desk. `team` carries the peer averages and the person's rank on
 * answer rate, because "86%" means nothing without "and the desk did 74%".
 *
 * Peer averages are unweighted — one person, one vote — so a colleague who took
 * two hundred alerts does not set the bar for everyone else.
 */
supportAdminRoutes.get('/people/:userId', async (c) => {
  const gate = await requireRoles(c, REPORT_ROLES)
  if (gate instanceof Response) return gate

  const userId = c.req.param('userId')
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 366)
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const [activity, daily, report, shifts, people] = await Promise.all([
    personActivity(userId, from, to),
    personDaily(userId, from, to),
    performance(from, to),
    userShifts(userId, from, to),
    peopleById([userId]),
  ])

  const person = people.get(userId)
  const peers = report.people.filter((row) => row.userId !== userId)
  const peerCount = Math.max(1, peers.length)
  const average = (pick: (row: (typeof peers)[number]) => number) =>
    peers.length === 0 ? 0 : peers.reduce((total, row) => total + pick(row), 0) / peerCount

  const ranked = report.people
    .filter((row) => row.offered > 0 && row.answerRate !== null)
    .sort(
      (left, right) =>
        (right.answerRate ?? 0) - (left.answerRate ?? 0) || right.answered - left.answered,
    )
  const position = ranked.findIndex((row) => row.userId === userId)

  return c.json({
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    person: {
      userId,
      name: person?.name ?? 'Former account',
      roles: person?.roles ?? [],
      activity,
    },
    daily,
    shifts,
    team: {
      people: report.people.length,
      peers: peers.length,
      totals: report.totals,
      perPerson: {
        offered: average((row) => row.offered),
        held: average((row) => row.held),
        answered: average((row) => row.answered),
        ignored: average((row) => row.ignored),
        missed: average((row) => row.missed),
        calls: average((row) => row.calls),
        talkSeconds: average((row) => row.talkSeconds),
        answerRate: average((row) => row.answerRate ?? 0),
      },
      rank: { answerRate: position >= 0 ? position + 1 : null, of: ranked.length },
    },
  })
})
