import type { Server as HttpServer } from 'node:http'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { loadEnv, serverPort } from './env.ts'
import { closePdfBrowser } from './pdf.ts'
import { adminDocumentRoutes } from './routes/adminDocuments.ts'
import { adminLocationRoutes, adminQuickBooksRoutes } from './routes/adminLocations.ts'
import {
  adminNotificationRoutes,
  notificationTagRoutes,
} from './routes/adminNotifications.ts'
import { accessRoutes } from './routes/access.ts'
import { adminUserRoutes } from './routes/adminUsers.ts'
import { alertRoutes, performanceRoutes } from './routes/activity.ts'
import { adminInvestmentRoutes, adminInvestorRoutes } from './routes/investorAdmin.ts'
import { authRoutes } from './routes/auth.ts'
import { cronRoutes } from './routes/cron.ts'
import { integrationRoutes } from './routes/integrations.ts'
import { intuitRoutes } from './routes/intuit.ts'
import { installationRoutes } from './routes/installations.ts'
import { investorRoutes } from './routes/investor.ts'
import { kpiRoutes } from './routes/kpi.ts'
import { pdfRoutes } from './routes/pdf.ts'
import { pushRoutes } from './routes/push.ts'
import { qrRoutes } from './routes/qr.ts'
import { qrPublicRoutes } from './routes/qrPublic.ts'
import { rtcCallRoutes } from './routes/rtcCalls.ts'
import { rtcRoutes } from './routes/rtc.ts'
import { supportRoutes } from './routes/support.ts'
import { supportAdminRoutes } from './routes/supportAdmin.ts'
import { attachRtcSignaling } from './rtcSignaling.ts'

/**
 * The API for the INSS apps.
 *
 * The paths are the ones the mobile client already calls (`/api/mobile/...`), so
 * pointing it at this service is a host change, not a client rewrite. Every
 * response is JSON except the magic-link landing page, which is HTML for a
 * browser.
 */

loadEnv()

const app = new Hono()

app.use('*', logger())

// The Expo web build runs on a different origin than this API, and a native
// client sends no Origin at all: the bearer token is the only credential, so any
// origin may call it.
app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
)

// Nothing here is cacheable: every response depends on who is asking.
app.use('/api/*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

app.get('/', (c) => c.text('inss-app-backend'))

app.route('/api/mobile/auth', authRoutes)
app.route('/api/mobile/admin/users', adminUserRoutes)
app.route('/api/mobile/admin/integrations', integrationRoutes)
app.route('/api/mobile/kpi', kpiRoutes)
app.route('/api/mobile/access', accessRoutes)
app.route('/api/mobile/investor', investorRoutes)
app.route('/api/mobile/pdf', pdfRoutes)

// The nightly data refresh. Not under /api/mobile: no app calls these, an
// external scheduler does, with the shared secret v1's Vercel crons used.
app.route('/api/cron', cronRoutes)

// The admin console. Locations feed both the KPI and the investor panels, the
// investor and investment routes back the portal's admin, and QR codes and
// Kiosk Connect are small registries of their own.
app.route('/api/mobile/admin/locations', adminLocationRoutes)
app.route('/api/mobile/admin/quickbooks', adminQuickBooksRoutes)
app.route('/api/mobile/admin/investors', adminInvestorRoutes)
app.route('/api/mobile/admin/investments', adminInvestmentRoutes)
app.route('/api/mobile/admin/documents', adminDocumentRoutes)
app.route('/api/mobile/admin/qr-codes', qrRoutes)

// Answering an alert: the person who was rung records that they did, which is
// what turns "we told six people" into a response time.
app.route('/api/mobile/alerts', alertRoutes)

// What the desk did over a window: offers, answers, response times and call
// minutes, per person and per property.
app.route('/api/mobile/admin/performance', performanceRoutes)

// Support sessions: the shift a support account opens to receive alerts, and
// the numbers it produced. The report above lives in the Support panel now, but
// its path stays — the panel is where it is read, not where it is served.
app.route('/api/mobile/support', supportRoutes)

// The other side of the same table: every alert, searchable and filtered, for
// Admin → Support. Administrator only, like the panel it feeds.
app.route('/api/mobile/admin/support', supportAdminRoutes)

// The notification tags: the vocabulary Users assigns, QR codes choose and the
// composer sends to. Administration only.
app.route('/api/mobile/admin/notification-tags', notificationTagRoutes)
app.route('/api/mobile/admin/notifications', adminNotificationRoutes)

// A phone registering to be told. The tags come from the account, never from the
// device, and delivery itself lives in `notifications.ts`.
app.route('/api/mobile/notifications', installationRoutes)
// Desktop alerts: the web build on Windows, macOS and Linux subscribing to be
// told. Delivery itself is inside `notifications.ts`, where a scan starts it.
app.route('/api/mobile/push', pushRoutes)
app.route('/api/mobile/admin/rtc', rtcRoutes)

// Placing a call: a socket token and ICE servers for the console and for a
// kiosk. The socket itself is on this same server, port and all.
app.route('/api/mobile/rtc', rtcCallRoutes)

// QuickBooks' OAuth callback, at the path v1 used so the redirect URI already
// registered with Intuit still points at a working endpoint.
app.route('/', intuitRoutes)

// What a scanned code resolves to, and the drawing a lobby screen displays. The
// pages themselves are in the app, because a printed sign encodes the app's
// hostname and that must not move when this API does.
app.route('/api/mobile/qr', qrPublicRoutes)

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((error, c) => {
  console.error('[api]', error)
  return c.json({ error: 'Something went wrong' }, 500)
})

// One HTTP server for the API and the signaling socket: a client only ever has
// to be pointed at this origin, which is what a host like Render gives it.
const httpServer = serve({ fetch: app.fetch, port: serverPort() }, (info) => {
  console.log(`inss-app-backend listening on http://localhost:${info.port}`)
}) as unknown as HttpServer

const signaling = attachRtcSignaling(httpServer)

// The PDF renderer keeps a headless Chrome alive between reports; a stopped
// server must not leave it running. Closing the socket server ends every call
// cleanly rather than leaving peers waiting on a dead connection.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void closePdfBrowser().finally(() => {
      signaling.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
    })
  })
}
