import { Hono } from 'hono'

import { requireAdmin } from '../auth/session.ts'
import { PdkError, confirmSystem, listSystems } from '../pdk/api.ts'
import { listDoors, openDoor } from '../pdk/doors.ts'
import { listHolders } from '../pdk/holders.ts'
import { clearSelectedSystem, saveSelectedSystem } from '../pdk/store.ts'
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
 * - **PDK** is deployment configuration. The API client credentials live in the
 *   server's environment, so there is nothing for an administrator to click —
 *   the page reads status live and, when it works, the doors.
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
        summary: 'Doors · holders · who opened what, when',
        connected: pdk?.connected === true,
        detail: pdk?.systemName ?? null,
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
 * The system, and how much is on it. `needsAttention` says what to fix when the
 * credentials are missing or refused.
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
 * The systems this API client can reach, so an administrator can pick one in the
 * app instead of copying an id into a deployment variable. PDK answers this from
 * the organizations the client belongs to.
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
 * POST /api/mobile/admin/integrations/pdk/system
 *
 * Body: { systemId }
 * Success: { integration: PdkStatus }
 *
 * The choice is confirmed against PDK before it is stored, so a typo or a system
 * the client cannot reach is refused here rather than showing as connected and
 * failing on the first door. It is a choice, not a credential: the client secret
 * stays in the environment.
 */
integrationRoutes.post('/pdk/system', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const body = (await c.req.json().catch(() => null)) as { systemId?: unknown } | null
  const systemId = typeof body?.systemId === 'string' ? body.systemId.trim() : ''
  if (!systemId) return c.json({ error: 'Choose a PDK system.' }, 400)

  try {
    const system = await confirmSystem(systemId)
    await saveSelectedSystem({ ...system, selectedBy: gate.userId })
    console.log('[pdk] system selected', { systemId, by: gate.userId })
    return c.json({ integration: await pdkStatus() })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/**
 * DELETE /api/mobile/admin/integrations/pdk/system
 *
 * Success: { integration: PdkStatus }
 *
 * Forgets the choice. The API client credentials are untouched, so another
 * system can be picked straight away.
 */
integrationRoutes.delete('/pdk/system', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  await clearSelectedSystem()
  console.log('[pdk] system selection cleared', { by: gate.userId })
  return c.json({ integration: await pdkStatus() })
})

/**
 * GET /api/mobile/admin/integrations/pdk/doors
 *
 * Success: { doors, total }
 *
 * Each door carries its cloud node and, when the node answered, its state.
 */
integrationRoutes.get('/pdk/doors', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  try {
    const { doors, total } = await listDoors()
    return c.json({ doors, total })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/**
 * POST /api/mobile/admin/integrations/pdk/doors/:deviceId/open
 *
 * Success: { ok: true }
 *
 * The node is taken from the device PDK returns, never from the request, so the
 * app can only open doors that are on this system.
 */
integrationRoutes.post('/pdk/doors/:deviceId/open', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  try {
    await openDoor(c.req.param('deviceId'))
    console.log('[pdk] door opened', { deviceId: c.req.param('deviceId'), by: gate.userId })
    return c.json({ ok: true })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})

/**
 * GET /api/mobile/admin/integrations/pdk/holders?search=
 *
 * Success: { holders, total }
 *
 * The read side only: access is granted in pdk.io, and a second place to edit it
 * would be a second place to get it wrong.
 */
integrationRoutes.get('/pdk/holders', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  try {
    const { holders, total } = await listHolders(c.req.query('search') ?? '')
    return c.json({ holders, total })
  } catch (cause) {
    const failure = pdkFailure(cause)
    return c.json({ error: failure.message }, failure.status)
  }
})
