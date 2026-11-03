import { Hono } from 'hono'

import { blobReadSignature } from '../azure.ts'
import { requireAdmin } from '../auth/session.ts'
import { fail, readJson } from '../http.ts'
import { investorData, investorFile, investorFiles } from '../investor.ts'
import { investorReport } from '../investorReports.ts'
import {
  adminInvestments,
  adminInvestors,
  equityAccounts,
  investorView,
  setInvestorInvestments,
} from '../investorAdmin.ts'

/**
 * The Investor Portal's admin data.
 *
 * Administrators only: these routes see every investor's associations, which is
 * exactly what the portal's own routes must never do.
 */

export const adminInvestorRoutes = new Hono()

/** GET /api/mobile/admin/investors — everyone with the investor role. */
adminInvestorRoutes.get('/', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ investors: await adminInvestors() })
})

/**
 * GET /api/mobile/admin/investors/equity-accounts
 *
 * Success: { accounts } — the QuickBooks equity accounts an investor is
 * associated with. Listed before `/:userId` so it is not read as an id.
 */
adminInvestorRoutes.get('/equity-accounts', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ accounts: await equityAccounts() })
})

/**
 * GET /api/mobile/admin/investors/:userId
 *
 * Success: { view } — the investor's holdings and total, per property.
 */
adminInvestorRoutes.get('/:userId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const view = await investorView(c.req.param('userId'))
  if (!view) return fail(c, 'That investor is not there', 404)

  return c.json({ view })
})

/**
 * PUT /api/mobile/admin/investors/:userId/investments   { investments }
 *
 * Success: { investor } — replaces the association list, creating the investor
 * record if this is the first time their equity is set up.
 */
adminInvestorRoutes.put('/:userId/investments', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  if (!Array.isArray(body.investments)) {
    return fail(c, 'Send the equity accounts to associate', 400)
  }

  const investments = body.investments.filter(
    (account): account is string => typeof account === 'string' && account.length > 0,
  )

  const investor = await setInvestorInvestments(c.req.param('userId'), investments)
  if (!investor) return fail(c, 'That investor is not there', 404)

  return c.json({ investor })
})

/**
 * GET /api/mobile/admin/investors/:userId/portfolio
 *
 * Success: { locations, portfolio, organizationPortfolio }
 *
 * "View as investor", which v1 offered as a tab on its investor page: the
 * administrator gets the same payload the investor's own route returns, built
 * by the same function, so a preview cannot drift from what is really shown.
 * 404 when the investor has no record yet — save their equity first.
 */
adminInvestorRoutes.get('/:userId/portfolio', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const data = await investorData(c.req.param('userId'))
  if (!data) return fail(c, 'No investor record is linked to this account', 404)

  return c.json(data)
})

/**
 * GET /api/mobile/admin/investors/:userId/files
 *
 * Success: { files } — the documents that investor sees, grouped by folder in
 * the app. Null from the data layer means no investor record, not "no files".
 */
adminInvestorRoutes.get('/:userId/files', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const files = await investorFiles(c.req.param('userId'))
  if (!files) return fail(c, 'No investor record is linked to this account', 404)

  return c.json({ files })
})

/**
 * GET /api/mobile/admin/investors/:userId/files/:fileId/url
 *
 * Success: { url, expiresOn } — a short-lived read-only signature for one of
 * that investor's documents. The file is looked up through their list first, so
 * a file outside their folders is a 404 even to an administrator.
 */
adminInvestorRoutes.get('/:userId/files/:fileId/url', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const file = await investorFile(c.req.param('userId'), c.req.param('fileId'))
  if (!file) return fail(c, 'That file is not there', 404)

  return c.json(blobReadSignature(file.container, file.blobName))
})

/**
 * GET /api/mobile/admin/investors/:userId/locations/:locationId/reports/:kind
 *
 * Success: { report } — one of the investor's property reports, exactly as the
 * portal builds it.
 */
adminInvestorRoutes.get('/:userId/locations/:locationId/reports/:kind', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const result = await investorReport(
    c.req.param('userId'),
    c.req.param('locationId'),
    c.req.param('kind'),
    { start: c.req.query('start'), end: c.req.query('end') },
  )

  if ('error' in result) return fail(c, result.error, result.status)
  return c.json({ report: result.report })
})

/** Every investment in the book, for the admin Equity tab. */
export const adminInvestmentRoutes = new Hono()

/** GET /api/mobile/admin/investments */
adminInvestmentRoutes.get('/', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ investments: await adminInvestments() })
})
