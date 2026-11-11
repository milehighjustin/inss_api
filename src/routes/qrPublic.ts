import { Hono } from 'hono'

import { notifyQrScan } from '../notifications.ts'
import { qrCode, qrCodeSvg } from '../qr.ts'

/**
 * The public data behind a scanned code.
 *
 * The pages themselves live in the app (`/qr/:id` and `/qr/:id/kiosk` on the web
 * build), because a printed sign encodes one hostname and that hostname must
 * never depend on where this API happens to run. What is left here is the two
 * things only the server can do: decide where a code points *now*, and record
 * that someone looked.
 *
 * Neither takes a credential — a code on a wall has no session — and neither may
 * be cached, because a destination or a deactivation has to take effect on the
 * next scan rather than whenever a browser decides to re-fetch.
 */

export const qrPublicRoutes = new Hono()

/** Where a scan goes when the code is unknown or switched off. */
const FALLBACK_URL = 'https://inselfstorage.com'

/**
 * POST /api/mobile/qr/:codeId/scan
 *
 * `{ url, live, name }` — where this code resolves right now.
 *
 * A POST because looking is the event: `notifyQrScan` may push to whoever the
 * code names, and a GET could be fired by a link preview or a prefetcher that
 * nobody actually read. The app calls it once when the scan page loads.
 *
 * An unknown or deactivated code answers 200 with the fallback destination
 * rather than an error: the visitor scanned a real sign, and a broken page is a
 * worse answer than the company homepage.
 */
qrPublicRoutes.post('/:codeId/scan', async (c) => {
  c.header('Cache-Control', 'no-store')

  const code = await qrCode(c.req.param('codeId'))
  if (!code || !code.active || !code.url) {
    return c.json({ url: FALLBACK_URL, live: false, name: code?.name ?? '' })
  }

  // The tags on the code are the audience; `notifyQrScan` returns null for a code
  // without one, so there is nothing to decide here. Awaited so the scan is
  // recorded before the page moves on, but a notification that cannot be written
  // must not stop the visitor being sent on.
  try {
    await notifyQrScan(code)
  } catch (cause) {
    console.error('[qr] could not record the scan:', cause)
  }

  return c.json({ url: code.url, live: true, name: code.name })
})

/**
 * GET /api/mobile/qr/:codeId/svg
 *
 * The drawing, as markup. The kiosk page renders it with react-native-svg, and
 * the admin console shows the same bytes, so a code on a screen and a code on a
 * sign are always the same picture. Unknown ids are a 404 — unlike a scan, a
 * display for a code that does not exist has nothing useful to show.
 */
qrPublicRoutes.get('/:codeId/svg', async (c) => {
  const svg = await qrCodeSvg(c.req.param('codeId'))

  if (!svg) {
    return c.json({ error: 'QR code not found' }, 404)
  }

  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'no-store',
  })
})
