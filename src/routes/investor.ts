import { Hono } from 'hono'

import { blobReadSignature } from '../azure.ts'
import { requireRoles } from '../auth/session.ts'
import { fail } from '../http.ts'
import { investorData, investorFile, investorFiles } from '../investor.ts'
import { investorReport } from '../investorReports.ts'

/**
 * The investor portal.
 *
 * Everything here is scoped to the caller's own investor record — there is no
 * `?investorId=` anywhere, so one investor cannot read another's portfolio or
 * documents by guessing an id. v1's investor page checks for the `investor` role
 * itself rather than using its shell's "investor" model, and so does this.
 */

const INVESTOR_ROLES = ['investor'] as const

export const investorRoutes = new Hono()

/**
 * GET /api/mobile/investor
 *
 * Success: { locations, portfolio, organizationPortfolio }
 *
 * 404 when the signed-in person has the role but no investor record: the portal
 * has nothing to show yet.
 */
investorRoutes.get('/', async (c) => {
  const user = await requireRoles(c, INVESTOR_ROLES)
  if (user instanceof Response) return user

  const data = await investorData(user.userId)
  if (!data) return fail(c, 'No investor record is linked to your account', 404)

  return c.json(data)
})

/**
 * GET /api/mobile/investor/files
 *
 * Success: { files: InvestorFile[] }
 */
investorRoutes.get('/files', async (c) => {
  const user = await requireRoles(c, INVESTOR_ROLES)
  if (user instanceof Response) return user

  const files = await investorFiles(user.userId)
  if (!files) return fail(c, 'No investor record is linked to your account', 404)

  return c.json({ files })
})

/**
 * GET /api/mobile/investor/files/:fileId/url
 *
 * Success: { url, expiresOn }
 *
 * A short-lived read-only signature for one document the caller is allowed to
 * see. The file is looked up through the investor's own list first, so a file
 * belonging to someone else is a 404 here even if its id is known.
 */
investorRoutes.get('/files/:fileId/url', async (c) => {
  const user = await requireRoles(c, INVESTOR_ROLES)
  if (user instanceof Response) return user

  const file = await investorFile(user.userId, c.req.param('fileId'))
  if (!file) return fail(c, 'That file is not there', 404)

  return c.json(blobReadSignature(file.container, file.blobName))
})

/**
 * GET /api/mobile/investor/locations/:locationId/reports/:kind?start=&end=
 *
 * Success: { report: ReportDocument }
 *
 * `kind` is `profit-loss` or `budget-vs-actual`. The
 * property is looked up in the caller's own portfolio first, so a property they
 * do not hold equity in is a 404 even if its id is known — v1 passed the
 * department id straight through from the browser, which meant any investor
 * could read any department's books.
 *
 * Dates are optional: without them the reply carries v1's default window for
 * that report, which is what the screen opens on. The lookup and the build live
 * in `investorReport` so the admin preview of a portfolio answers identically.
 */
investorRoutes.get('/locations/:locationId/reports/:kind', async (c) => {
  const user = await requireRoles(c, INVESTOR_ROLES)
  if (user instanceof Response) return user

  const result = await investorReport(
    user.userId,
    c.req.param('locationId'),
    c.req.param('kind'),
    { start: c.req.query('start'), end: c.req.query('end') },
  )

  if ('error' in result) return fail(c, result.error, result.status)
  return c.json({ report: result.report })
})
