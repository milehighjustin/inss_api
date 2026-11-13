import { Hono } from 'hono'

import { alertLog, type AlertActionFilter } from '../alertLog.ts'
import { requireAdmin } from '../auth/session.ts'

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
