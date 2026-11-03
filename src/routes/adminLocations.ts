import { Hono } from 'hono'

import {
  LocationError,
  adminLocation,
  adminLocations,
  createLocationNote,
  deleteLocationNote,
  quickBooksDepartments,
  updateAdminLocation,
} from '../adminLocations.ts'
import { requireAdmin } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'

/**
 * Locations, for the admin console.
 *
 * Both admin areas read the same records: the KPI panel only changes `kpiActive`
 * and the OER score, the Investor Portal panel changes the manual inputs, the
 * QuickBooks link, the status and the notes. One route set keeps them in step.
 */

export const adminLocationRoutes = new Hono()

/** GET /api/mobile/admin/locations — every location, by property name. */
adminLocationRoutes.get('/', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ locations: await adminLocations() })
})

/** GET /api/mobile/admin/locations/:locationId — one location with its notes. */
adminLocationRoutes.get('/:locationId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const location = await adminLocation(c.req.param('locationId'))
  if (!location) return fail(c, 'Location not found', 404)

  return c.json({ location })
})

/**
 * PATCH /api/mobile/admin/locations/:locationId
 *
 * Success: { location }
 *
 * Accepts any subset of the editable fields — the manual inputs, `status`,
 * `kpiActive`, `oerScore`, and the QuickBooks department (id and name together).
 */
adminLocationRoutes.patch('/:locationId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const location = await updateAdminLocation(c.req.param('locationId'), {
      ...(body.internalId !== undefined ? { internalId: text(body.internalId) } : {}),
      ...(body.acquisitionDate !== undefined ? { acquisitionDate: text(body.acquisitionDate) } : {}),
      ...(body.valuationDate !== undefined ? { valuationDate: text(body.valuationDate) } : {}),
      ...(body.loanMaturityDate !== undefined
        ? { loanMaturityDate: text(body.loanMaturityDate) }
        : {}),
      ...(body.budgetOccupancy !== undefined
        ? { budgetOccupancy: body.budgetOccupancy as number }
        : {}),
      ...(body.propertyValue !== undefined ? { propertyValue: body.propertyValue as number } : {}),
      ...(body.operatingCashReserves !== undefined
        ? { operatingCashReserves: body.operatingCashReserves as number }
        : {}),
      ...(body.loanInterestRate !== undefined
        ? { loanInterestRate: body.loanInterestRate as number }
        : {}),
      ...(body.issPromote !== undefined ? { issPromote: body.issPromote as number } : {}),
      ...(body.projectedCapitalCalls !== undefined
        ? { projectedCapitalCalls: body.projectedCapitalCalls as number }
        : {}),
      ...(body.closingCostPct !== undefined ? { closingCostPct: body.closingCostPct as number } : {}),
      ...(body.status !== undefined ? { status: body.status as never } : {}),
      ...(body.kpiActive !== undefined ? { kpiActive: body.kpiActive as boolean } : {}),
      ...(body.oerScore !== undefined ? { oerScore: body.oerScore as number | null } : {}),
      ...(body.departmentId !== undefined
        ? {
            departmentId: text(body.departmentId),
            departmentName: text(body.departmentName),
          }
        : {}),
    })

    if (!location) return fail(c, 'Location not found', 404)
    return c.json({ location })
  } catch (cause) {
    if (cause instanceof LocationError) return fail(c, cause.message, 400)
    throw cause
  }
})

/** POST /api/mobile/admin/locations/:locationId/notes   { content } */
adminLocationRoutes.post('/:locationId/notes', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const locationId = c.req.param('locationId')
  const location = await adminLocation(locationId)
  if (!location) return fail(c, 'Location not found', 404)

  const body = await readJson(c)
  const content = text(body.content)
  if (!content) return fail(c, 'Write the note before saving it', 400)

  const author = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Administrator'
  const note = await createLocationNote(locationId, content, author)
  if (!note) return fail(c, 'The note could not be saved', 500)

  return c.json({ note }, 201)
})

/** DELETE /api/mobile/admin/locations/:locationId/notes/:noteId */
adminLocationRoutes.delete('/:locationId/notes/:noteId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const deleted = await deleteLocationNote(
    c.req.param('locationId'),
    c.req.param('noteId'),
  )
  if (!deleted) return fail(c, 'That note is not there', 404)

  return c.json({ deleted: true })
})

/** The QuickBooks departments the location form links to. */
export const adminQuickBooksRoutes = new Hono()

/** GET /api/mobile/admin/quickbooks/departments */
adminQuickBooksRoutes.get('/departments', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ departments: await quickBooksDepartments() })
})
