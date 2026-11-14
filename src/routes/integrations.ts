import { Hono } from 'hono'

import { adminLocation } from '../adminLocations.ts'
import { requireAdmin } from '../auth/session.ts'
import { PdkError, confirmSystem, listSystems } from '../pdk/api.ts'
import { clearLocationSystem, listLocationSystems, saveLocationSystem } from '../pdk/links.ts'
import { pdkStatus } from '../pdk/status.ts'
import { authorizeUrl, mintState, STATE_EXPIRES_SECONDS } from '../quickbooks/oauth.ts'
import { quickBooksStatus } from '../quickbooks/status.ts'

/**
 * Integrations, for administrators.
 *
 * Two integrations, and the shape is the same for both: the panel lists what the
 * app can connect to, and each one has its own page behind that list. Adding a
 * third means adding an entry to the index and a page, not another block on one
 * long screen.
 *
 * They connect differently, and the difference is honest:
 *
 * - **QuickBooks** is a browser errand. The API hands back an authorize URL, an
 *   administrator signs in to Intuit, and the callback stores the tokens.
 * - **PDK** is deployment configuration plus a per-property link. The API client
 *   credentials live in the server's environment; which system a property uses is
 *   a choice, and there is one per property because a PDK system is a site.
 */

export const integrationRoutes = new Hono()

/**
 * One line per integration for the index page.
 *
 * Both statuses are read live and in parallel: the index exists to say whether
 * each connection works, so a cached answer would be the one thing it must not
 * show. A failure in one must not blank the list, which is why each is caught.
 */
integrationRoutes.get('/', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const [quickbooks, pdk] = await Promise.all([
    quickBooksStatus().catch(() => null),
    pdkStatus().catch(() => null),
  ])

  return c.json({
    integrations: [
      {
        id: 'quickbooks',
        name: 'QuickBooks Online',
        summary: 'Accounting · portfolio reports and facility metrics',
        connected: quickbooks?.connected === true,
        detail: quickbooks?.companyName ?? null,
        needsAttention: quickbooks
          ? quickbooks.needsAttention
          : 'QuickBooks could not be checked just now.',
        checkedAt: quickbooks?.checkedAt ?? new Date().toISOString(),
      },
      {
        id: 'pdk',
        name: 'PDK Access Control',
        summary: 'Doors · holders · gates and access per property',
        connected: (pdk?.reachable ?? 0) > 0,
        detail:
          pdk && pdk.linked > 0
            ? `${pdk.reachable} of ${pdk.linked} linked propert${pdk.linked === 1 ? 'y' : 'ies'} answering`
            : null,
        needsAttention: pdk ? pdk.needsAttention : 'PDK could not be checked just now.',
        checkedAt: pdk?.checkedAt ?? new Date().toISOString(),
      },
    ],
  })
})

/**
 * GET /api/mobile/admin/integrations/quickbooks
 *
 * Success: { integration }
 *
 * Read live: the stored tokens are used to ask Intuit for the company, so a
 * green light means the connection actually works. `needsAttention` carries the
 * sentence to show when it does not.
 */
integrationRoutes.get('/quickbooks', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  return c.json({ integration: await quickBooksStatus() })
})

/**
 * POST /api/mobile/admin/integrations/quickbooks/connect
 *
 * Success: { url, expiresOn }
 *
 * `url` is Intuit's authorize page for this company, already carrying a signed
 * `state` that names the administrator. The app opens it in a browser; nothing
 * is written until Intuit calls back.
 */
integrationRoutes.post('/quickbooks/connect', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  try {
    const state = mintState(gate.userId)
    const url = await authorizeUrl({ requestUrl: c.req.url, state })

    return c.json({
      url,
      expiresOn: new Date(Date.now() + STATE_EXPIRES_SECONDS * 1000).toISOString(),
    })
  } catch (cause) {
    console.error('[quickbooks] could not start the connection', {
      message: cause instanceof Error ? cause.message : String(cause),
    })
    return c.json(
      { error: 'Could not reach QuickBooks to start the connection. Try again in a moment.' },
      502,
    )
  }
})

/** A PDK failure, as the panel needs to hear it. */
function pdkFailure(cause: unknown) {
  if (cause instanceof PdkError) {
    return { message: cause.message, status: cause.status as 404 | 409 | 502 }
  }

  console.error('[pdk] unexpected failure', {
    message: cause instanceof Error ? cause.message : String(cause),
  })
  return { message: 'PDK could not answer that request just now.', status: 502 as const }
}

/**
 * GET /api/mobile/admin/integrations/pdk
 *
 * Success: { integration: PdkStatus }
 *
 * How many properties are linked, and how many of their systems answered.
 */
integrationRoutes.get('/pdk', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  return c.json({ integration: await pdkStatus() })
})

/**
 * GET /api/mobile/admin/integrations/pdk/systems
 *
 * Success: { systems: [{ systemId, name, organizationId, cloudNodes }] }
 *
 * The systems this API client can reach, so a property can be pointed at one in
 * the app instead of copying an id into a deployment variable. PDK answers this
 * from the organizations the client belongs to.
 */
integrationRoutes.get('/pdk/systems', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  try {
    return c.json({ systems: await listSystems() })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/**
 * GET /api/mobile/admin/integrations/pdk/links
 *
 * Success: { links: [{ locationId, systemId, systemName, organizationId, linkedBy, linkedAt }] }
 *
 * Which property uses which system. The property names are the app's to add —
 * this is the association, and nothing else.
 */
integrationRoutes.get('/pdk/links', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  return c.json({ links: await listLocationSystems() })
})

/**
 * POST /api/mobile/admin/integrations/pdk/links
 *
 * Body: { locationId, systemId }
 * Success: { link }
 *
 * The system is confirmed with PDK before it is stored, so a system this client
 * cannot reach is refused here rather than looking linked until the first door.
 * Linking a property that already has one replaces it — a site has one system.
 */
integrationRoutes.post('/pdk/links', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const body = (await c.req.json().catch(() => null)) as
    | { locationId?: unknown; systemId?: unknown }
    | null
  const locationId = typeof body?.locationId === 'string' ? body.locationId.trim() : ''
  const systemId = typeof body?.systemId === 'string' ? body.systemId.trim() : ''

  if (!locationId) return c.json({ error: 'Choose a property.' }, 400)
  if (!systemId) return c.json({ error: 'Choose a PDK system.' }, 400)

  const location = await adminLocation(locationId)
  if (!location) return c.json({ error: 'That property is not there.' }, 404)

  try {
    const system = await confirmSystem(systemId)
    const link = await saveLocationSystem({
      locationId,
      ...system,
      linkedBy: gate.userId,
    })
    console.log('[pdk] property linked', { locationId, systemId, by: gate.userId })
    return c.json({ link }, 201)
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/**
 * DELETE /api/mobile/admin/integrations/pdk/links/:locationId
 *
 * Success: { ok: true }
 *
 * Unlinks the property. The PDK system, its doors and its holders are untouched.
 */
integrationRoutes.delete('/pdk/links/:locationId', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  await clearLocationSystem(c.req.param('locationId'))
  console.log('[pdk] property unlinked', { locationId: c.req.param('locationId'), by: gate.userId })
  return c.json({ ok: true })
})
