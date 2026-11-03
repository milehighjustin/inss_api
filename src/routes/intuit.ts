import { Hono } from 'hono'

import { companyInfo, persistTokens } from '../quickbooks/api.ts'
import { CALLBACK_PATH, exchangeCode, verifyState } from '../quickbooks/oauth.ts'
import { integrationPage } from '../quickbooks/page.ts'

/**
 * The end of the QuickBooks connection, in the browser.
 *
 * Mounted at v1's exact path, so the redirect URI registered in the Intuit
 * developer app keeps working. Nothing here takes a bearer token: the signed
 * `state` from the connect request is the proof that an administrator started
 * this, and it expires in fifteen minutes.
 *
 * Every outcome is a page, because a browser is looking at it.
 */

export const intuitRoutes = new Hono()

intuitRoutes.get(CALLBACK_PATH, async (c) => {
  const params = new URL(c.req.url).searchParams

  // Cancelled, or Intuit refused. Nothing was written.
  if (params.get('error')) {
    return c.html(
      integrationPage({
        title: 'QuickBooks was not connected',
        message:
          params.get('error_description') ||
          'The connection was cancelled before it finished. Nothing was changed.',
        detail: 'Start again from Admin → Integrations in the app.',
        tone: 'error',
      }),
      400,
    )
  }

  const userId = verifyState(params.get('state') ?? undefined)
  if (!userId) {
    return c.html(
      integrationPage({
        title: 'This connection link expired',
        message:
          'Connection links are good for fifteen minutes, and this one is no longer valid. Nothing was changed.',
        detail: 'Start again from Admin → Integrations in the app.',
        tone: 'error',
      }),
      400,
    )
  }

  const code = params.get('code') ?? ''
  const realmId = params.get('realmId') ?? ''
  if (!code || !realmId) {
    return c.html(
      integrationPage({
        title: 'QuickBooks sent an incomplete reply',
        message:
          'The authorization code or the company id was missing, so nothing could be saved.',
        detail: 'Start again from Admin → Integrations in the app.',
        tone: 'error',
      }),
      400,
    )
  }

  try {
    const tokens = await exchangeCode(code, c.req.url)
    await persistTokens(tokens, { realmId, connectedBy: userId })
  } catch (cause) {
    console.error('[quickbooks] connection failed', {
      message: cause instanceof Error ? cause.message : String(cause),
    })
    return c.html(
      integrationPage({
        title: 'QuickBooks could not be connected',
        message:
          'Intuit accepted the sign-in but the tokens could not be saved. Check the server log for the reason.',
        detail: 'Start again from Admin → Integrations in the app.',
        tone: 'error',
      }),
      502,
    )
  }

  // Best effort: the company name is nice to confirm, not worth failing over.
  let company: string | null = null
  try {
    company = (await companyInfo()).name
  } catch (cause) {
    console.error('[quickbooks] connected, but the company could not be read', {
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }

  return c.html(
    integrationPage({
      title: 'QuickBooks is connected',
      message: company
        ? `${company} is now linked, so portfolio reports and metrics can read from it.`
        : 'QuickBooks is now linked, so portfolio reports and metrics can read from it.',
      detail: 'Close this tab and return to the app. Integrations updates by itself.',
    }),
  )
})
