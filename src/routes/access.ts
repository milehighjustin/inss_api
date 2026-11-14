import { Hono } from 'hono'

import { adminLocations } from '../adminLocations.ts'
import { requireRoles, type SessionUser } from '../auth/session.ts'
import { PdkError } from '../pdk/api.ts'
import { listDoors, openDoor } from '../pdk/doors.ts'
import {
  createHolder,
  getHolder,
  listGroups,
  listHolders,
  listPartitions,
  updateHolder,
  type HolderInput,
} from '../pdk/holders.ts'
import { listLocationSystems } from '../pdk/links.ts'

/**
 * Access Management.
 *
 * The screens behind the `access` role: the properties that have a PDK system,
 * their gates, their holders. This is deliberately not part of Admin — the
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
 * GET /api/mobile/access/:locationId/partitions and /groups
 *
 * Success: { partitions } / { groups }
 *
 * The two lists the holder editor needs: PDK files every holder under a
 * partition, and groups are what carry shared rules.
 */
accessRoutes.get('/:locationId/partitions', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  try {
    return c.json({ partitions: await listPartitions(c.req.param('locationId')) })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

accessRoutes.get('/:locationId/groups', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  try {
    return c.json({ groups: await listGroups(c.req.param('locationId')) })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/** GET /api/mobile/access/:locationId/holders/:holderId — Success: { holder } */
accessRoutes.get('/:locationId/holders/:holderId', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  try {
    const holder = await getHolder(c.req.param('locationId'), c.req.param('holderId'))
    return c.json({ holder })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/** A holder body, or the sentence saying what is wrong with it. */
function readHolderInput(body: unknown): HolderInput | string {
  const raw = (body ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

  const firstName = text(raw.firstName)
  const lastName = text(raw.lastName)
  if (!firstName || !lastName) return 'A holder needs a first and a last name.'

  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
  const groupIds = Array.isArray(raw.groupIds)
    ? raw.groupIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : []

  return {
    firstName,
    lastName,
    email: text(raw.email) || null,
    partitionId: text(raw.partitionId) || null,
    enabled,
    activeDate: text(raw.activeDate) || null,
    expireDate: text(raw.expireDate) || null,
    pin: text(raw.pin) || null,
    duressPin: text(raw.duressPin) || null,
    groupIds,
  }
}

/**
 * POST /api/mobile/access/:locationId/holders
 *
 * Body: { firstName, lastName, email?, partitionId?, activeDate?, expireDate?,
 *         pin?, duressPin?, groupIds? }
 * Success: { holder }
 *
 * Everything PDK lets you set on a holder at creation, because a tenant's gate
 * code is issued here or not at all.
 */
accessRoutes.post('/:locationId/holders', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  const parsed = readHolderInput(await c.req.json().catch(() => null))
  if (typeof parsed === 'string') return c.json({ error: parsed }, 400)

  try {
    const holder = await createHolder(c.req.param('locationId'), parsed)
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

/**
 * PUT /api/mobile/access/:locationId/holders/:holderId
 *
 * Body: the same fields as the create.
 * Success: { holder }
 *
 * A replacement, as PDK's update is: the editor starts from the holder as it
 * stands, so what it sends is the whole record and nothing is cleared by
 * omission.
 */
accessRoutes.put('/:locationId/holders/:holderId', async (c) => {
  const user = await gate(c)
  if (user instanceof Response) return user

  const parsed = readHolderInput(await c.req.json().catch(() => null))
  if (typeof parsed === 'string') return c.json({ error: parsed }, 400)

  try {
    const holder = await updateHolder(c.req.param('locationId'), c.req.param('holderId'), parsed)
    console.log('[pdk] holder changed', {
      locationId: c.req.param('locationId'),
      holderId: c.req.param('holderId'),
      by: user.userId,
    })
    return c.json({ holder })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})
