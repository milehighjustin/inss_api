import { Hono } from 'hono'

import { requireAdmin } from '../auth/session.ts'
import { authorizeUrl, mintState, STATE_EXPIRES_SECONDS } from '../quickbooks/oauth.ts'
import { quickBooksStatus } from '../quickbooks/status.ts'

/**
 * Integrations, for administrators.
 *
 * One integration today — QuickBooks — but the panel is shaped as a connection
 * the app checks and renews, not as a form it submits. Connecting is a browser
 * errand: this API hands back an authorize URL, the browser goes to Intuit, and
 * the callback lands on the same path v1 used.
 */

export const integrationRoutes = new Hono()

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
