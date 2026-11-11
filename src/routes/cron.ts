import { Hono } from 'hono'
import type { Context } from 'hono'

import { cronAuthorized } from '../cron/auth.ts'
import { processCubbyData, refreshCubbyData } from '../cron/cubby.ts'
import {
  refreshAccounts,
  refreshBudget,
  refreshDepartments,
  refreshDividends,
  refreshEntitiesInvested,
  refreshLoanBalances,
  refreshProfitLoss,
} from '../cron/quickbooks.ts'
import { refreshInvestorRoles } from '../cron/roles.ts'
import { runRefresh, type RefreshReport } from '../cron/run.ts'
import { pruneBrowserSubscriptions } from '../push/browser.ts'
import { reconcileInstallations } from '../push/installations.ts'

/**
 * The data refresh, as endpoints a scheduler calls.
 *
 * v1 ran these as Vercel crons (`vercel.json`): QuickBooks every five hours,
 * Cubby at 08:30 and its processing at 10:30. The website is not going to
 * production, so the schedules here are deliberately not baked in — any
 * scheduler that can send a header can drive them:
 *
 *   GET /api/cron/quickbooks     every few hours (v1: 0 0-23/5 * * *)
 *   GET /api/cron/cubby          08:30 (v1: 30 8 * * *)
 *   GET /api/cron/cubby-process  10:30 (v1: 30 10 * * *)
 *   GET /api/cron/roles          by hand, when investor records change
 *
 * Every route wants `Authorization: Bearer $CRON_SECRET`, the header v1 used.
 * Each answers with the same report — one entry per step, how long it took, what
 * it wrote or why it failed — and a 500 when any step failed, so a scheduler's
 * own alerting works without parsing the body.
 */

export const cronRoutes = new Hono()

cronRoutes.use('*', async (c, next) => {
  if (!cronAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

function respond(c: Context, report: RefreshReport) {
  return c.json(report, report.ok ? 200 : 500)
}

/**
 * QuickBooks: departments, accounts, budgets, loans, equity, dividends and P&L.
 *
 * One endpoint rather than seven, because they share a token and a pull order:
 * the accounts and departments have to be current before budgets, equity and
 * dividends can be attributed to a property.
 */
cronRoutes.get('/quickbooks', async (c) => {
  const report = await runRefresh([
    { name: 'departments', run: refreshDepartments },
    { name: 'accounts', run: refreshAccounts },
    { name: 'budgets', run: refreshBudget },
    { name: 'loan-balances', run: refreshLoanBalances },
    { name: 'entities-invested', run: refreshEntitiesInvested },
    { name: 'dividends', run: refreshDividends },
    { name: 'profit-loss', run: refreshProfitLoss },
  ])

  return respond(c, report)
})

/** Cubby stage one: the facility list, the rent roll, pricing groups and AR. */
cronRoutes.get('/cubby', async (c) => {
  const report = await runRefresh([{ name: 'cubby-ingest', run: refreshCubbyData }])
  return respond(c, report)
})

/** Cubby stage two: the staging collections into each facility's metrics. */
cronRoutes.get('/cubby-process', async (c) => {
  const report = await runRefresh([{ name: 'cubby-process', run: processCubbyData }])
  return respond(c, report)
})

/**
 * Phone installations the hub refused are retried and devices nobody has opened
 * in three months are forgotten.
 *
 * This is what makes a tag change eventually true for the phones: saving tags
 * rewrites each installation, and anything the hub rejected that moment is fixed
 * here rather than being silently stale forever. Browsers have nothing to
 * repair — their subscription is used exactly as stored — so for them this job
 * only prunes the ones the app has not re-registered in months.
 */
cronRoutes.get('/notifications-sync', async (c) => {
  const report = await runRefresh([
    { name: 'installations', run: () => reconcileInstallations() },
    { name: 'browsers', run: () => pruneBrowserSubscriptions() },
  ])

  return respond(c, report)
})

/** The `investor` role, added to and removed from the accounts that need it. */
cronRoutes.get('/roles', async (c) => {
  const report = await runRefresh([{ name: 'investor-roles', run: refreshInvestorRoles }])
  return respond(c, report)
})
