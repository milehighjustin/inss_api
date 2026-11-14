import { Hono } from 'hono'

import { adminLocations } from '../adminLocations.ts'
import { requireRoles, type SessionUser } from '../auth/session.ts'
import { PdkError } from '../pdk/api.ts'
import { listDoors, openDoor } from '../pdk/doors.ts'
import { createHolder, listHolders } from '../pdk/holders.ts'
import { listLocationSystems } from '../pdk/links.ts'

/**
 * Access Management.
 *
 * The screens behind the `access` role: the properties that have a PDK system,
 * their gates, and their holders. This is deliberately not part of Admin — the
 * person at the desk who buzzes a tenant in is not editing the integration, and
 * the person who links a property is not opening gates at midnight. Both reach
 * the same PDK systems through different doors.
 *
 * Every route starts from a property, because a PDK system is a site: the link
 * made in Admin → Integrations → PDK is what decides which system answers.
 * Nothing here can name a system id directly.
 */

export const accessRoutes = new Hono()

/** The roles that may open a gate or read a holder. */
export const ACCESS_ROLES = ['access', 'administrator'] as const

async function gate(c: Parameters<typeof requireRoles>[0]): Promise<SessionUser | Response> {
  return requireRoles(c, ACCESS_ROLES)
}

function pdkFailure(cause: unknown) {
  if (cause instanceof PdkError) {
    return { message: cause.message, status: cause.status as 404 | 409 | 502 }
  }

  console.error('[pdk] access request failed', {
    message: cause instanceof Error ? cause.message : String(cause),
  })
  return { message: 'PDK could not answer that request just now.', status: 502 as const }
}

/**
 * GET /api/mobile/access
 *
 * Success: { properties: [{ locationId, name, systemId, systemName, linkedAt }] }
 *
 * Only properties with a system linked: a tile for a property with no gates to
 * open would be a door that goes nowhere.
 */
accessRoutes.get('/', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  const [links, locations] = await Promise.all([listLocationSystems(), adminLocations()])
  const names = new Map(
    locations.map((location) => [
      location.id,
      location.departmentName || location.name || location.internalId || 'Property',
    ]),
  )

  const properties = links
    .map((link) => ({
      locationId: link.locationId,
      name: names.get(link.locationId) ?? 'Property',
      systemId: link.systemId,
      systemName: link.systemName,
      linkedAt: link.linkedAt,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))

  return c.json({ properties })
})

/** GET /api/mobile/access/:locationId/doors — Success: { doors, total } */
accessRoutes.get('/:locationId/doors', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  try {
    const { doors, total } = await listDoors(c.req.param('locationId'))
    return c.json({ doors, total })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/**
 * POST /api/mobile/access/:locationId/doors/:deviceId/open
 *
 * Success: { ok: true }
 *
 * The cloud node comes from the device PDK returns for this property's system,
 * never from the request, so this can only command a door that is on it.
 */
accessRoutes.post('/:locationId/doors/:deviceId/open', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  try {
    await openDoor(c.req.param('locationId'), c.req.param('deviceId'))
    console.log('[pdk] door opened', {
      locationId: c.req.param('locationId'),
      deviceId: c.req.param('deviceId'),
      by: user.userId,
    })
    return c.json({ ok: true })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/** GET /api/mobile/access/:locationId/holders?search= — Success: { holders, total } */
accessRoutes.get('/:locationId/holders', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  try {
    const { holders, total } = await listHolders(
      c.req.param('locationId'),
      c.req.query('search') ?? '',
    )
    return c.json({ holders, total })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/**
 * POST /api/mobile/access/:locationId/holders
 *
 * Body: { firstName, lastName, email?, phone? }
 * Success: { holder }
 *
 * A new tenant needs a holder before their gate works, and going to pdk.io for
 * it meant leaving the screen someone was already using.
 */
accessRoutes.post('/:locationId/holders', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  const body = (await c.req.json().catch(() => null)) as
    | { firstName?: unknown; lastName?: unknown; email?: unknown; phone?: unknown }
    | null

  const firstName = typeof body?.firstName === 'string' ? body.firstName.trim() : ''
  const lastName = typeof body?.lastName === 'string' ? body.lastName.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : ''

  if (!firstName || !lastName) {
    return c.json({ error: 'A holder needs a first and a last name.' }, 400)
  }

  try {
    const holder = await createHolder(c.req.param('locationId'), {
      firstName,
      lastName,
      email: email || null,
      phone: phone || null,
    })
    console.log('[pdk] holder added', {
      locationId: c.req.param('locationId'),
      holderId: holder.id,
      by: user.userId,
    })
    return c.json({ holder }, 201)
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})
