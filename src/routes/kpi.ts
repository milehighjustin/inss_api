import { Hono } from 'hono'

import { requireRoles } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import { KPI_ROLES, kpiFacilities } from '../kpi.ts'
import {
  createSavedKpiList,
  deleteSavedKpiList,
  savedKpiLists,
} from '../kpiLists.ts'

/**
 * The facility KPI board and its saved lists.
 *
 * The board is read-only: one call returns every facility with the metrics v1's
 * table shows, and the client sorts, searches and filters. Lists are the only
 * writes, because people keep named subsets ("my facilities") to switch between.
 */

export const kpiRoutes = new Hono()

/**
 * GET /api/mobile/kpi
 *
 * Success: { facilities: KpiFacility[] }
 *
 * Administrators, managers and supervisors see every active facility — v1 has no
 * per-person facility scoping, and its nav admits those three roles.
 */
kpiRoutes.get('/', async (c) => {
  const user = await requireRoles(c, KPI_ROLES)
  if (user instanceof Response) return user

  return c.json({ facilities: await kpiFacilities() })
})

/**
 * GET /api/mobile/kpi/lists
 *
 * Success: { lists: SavedKpiList[] }
 */
kpiRoutes.get('/lists', async (c) => {
  const user = await requireRoles(c, KPI_ROLES)
  if (user instanceof Response) return user

  return c.json({ lists: await savedKpiLists() })
})

/**
 * POST /api/mobile/kpi/lists   { name, facilityIds }
 *
 * Success: { list } (201)
 *
 * The same thing v1's "Save List" modal writes: a name and the ids of the
 * facilities that were selected.
 */
kpiRoutes.post('/lists', async (c) => {
  const user = await requireRoles(c, KPI_ROLES)
  if (user instanceof Response) return user

  const body = await readJson(c)
  const name = text(body.name)
  if (!name) return fail(c, 'Name the list before saving it', 400)

  const facilityIds = Array.isArray(body.facilityIds)
    ? body.facilityIds.filter((id): id is string => typeof id === 'string')
    : []
  if (facilityIds.length === 0) return fail(c, 'Choose at least one facility', 400)

  return c.json({ list: await createSavedKpiList(name, facilityIds) }, 201)
})

/**
 * DELETE /api/mobile/kpi/lists/:listId
 *
 * Success: { deleted: true }
 */
kpiRoutes.delete('/lists/:listId', async (c) => {
  const user = await requireRoles(c, KPI_ROLES)
  if (user instanceof Response) return user

  const deleted = await deleteSavedKpiList(c.req.param('listId'))
  if (!deleted) return fail(c, 'That list is no longer there', 404)

  return c.json({ deleted: true })
})
